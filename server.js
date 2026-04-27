
const express = require("express");
const cors = require("cors");
const crypto = require("crypto");
const path = require("path");
const mysql = require("mysql2/promise");

const app = express();
app.use(cors());
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

const ACCESS_TOKEN = process.env.MERCADO_PAGO_ACCESS_TOKEN;
const ADMIN_SENHA = process.env.ADMIN_SENHA || "dede123";
const PORT = process.env.PORT || 3000;

const DB_CONFIG = {
  host: process.env.DB_HOST || "localhost",
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
};

let pool;

function moeda(valor) {
  return Number(valor || 0).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}

function exigirBancoConfigurado() {
  if (!DB_CONFIG.user || !DB_CONFIG.database) {
    throw new Error("Banco MySQL não configurado. Verifique DB_HOST, DB_USER, DB_PASSWORD e DB_NAME no .env.");
  }
}

async function conectarBanco() {
  exigirBancoConfigurado();
  if (!pool) pool = mysql.createPool(DB_CONFIG);
  return pool;
}

async function initDb() {
  const db = await conectarBanco();

  await db.query(`
    CREATE TABLE IF NOT EXISTS cardapio (
      id INT AUTO_INCREMENT PRIMARY KEY,
      nome VARCHAR(150) NOT NULL,
      preco DECIMAL(10,2) NOT NULL,
      descricao TEXT NULL,
      disponivel TINYINT(1) NOT NULL DEFAULT 1,
      criado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      atualizado_em TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS pedidos (
      id VARCHAR(36) PRIMARY KEY,
      payment_id VARCHAR(80) NULL,
      criado_em DATETIME NOT NULL,
      atualizado_em DATETIME NOT NULL,
      status_pagamento VARCHAR(40) NOT NULL,
      status_pedido VARCHAR(40) NOT NULL DEFAULT 'novo',
      cliente_nome VARCHAR(150) NOT NULL,
      cliente_bloco VARCHAR(50) NULL,
      cliente_apartamento VARCHAR(50) NOT NULL,
      observacao TEXT NULL,
      pagamento VARCHAR(40) NOT NULL,
      total DECIMAL(10,2) NOT NULL,
      INDEX idx_payment_id (payment_id),
      INDEX idx_status_pedido (status_pedido),
      INDEX idx_criado_em (criado_em)
    )
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS pedido_itens (
      id INT AUTO_INCREMENT PRIMARY KEY,
      pedido_id VARCHAR(36) NOT NULL,
      item_cardapio_id INT NULL,
      nome VARCHAR(150) NOT NULL,
      quantidade INT NOT NULL,
      preco DECIMAL(10,2) NOT NULL,
      subtotal DECIMAL(10,2) NOT NULL,
      INDEX idx_pedido_id (pedido_id),
      CONSTRAINT fk_pedido_itens_pedido
        FOREIGN KEY (pedido_id) REFERENCES pedidos(id)
        ON DELETE CASCADE
    )
  `);

  const [rows] = await db.query("SELECT COUNT(*) AS total FROM cardapio");
  if (Number(rows[0].total) === 0) {
    await db.query(
      `INSERT INTO cardapio (nome, preco, descricao, disponivel) VALUES
       (?, ?, ?, 1), (?, ?, ?, 1), (?, ?, ?, 1), (?, ?, ?, 1)`,
      [
        "Feijoada Individual", 20.00, "Porção individual caprichada.",
        "Feijoada para duas pessoas", 38.00, "Serve bem duas pessoas.",
        "Pote de 1kg de feijoada", 47.00, "Ideal para compartilhar ou guardar.",
        "Calabresa Toscana (2 unidades)", 7.00, "Adicional com 2 unidades.",
      ]
    );
  }
}

function rowToPrato(row) {
  return { id: Number(row.id), nome: row.nome, preco: Number(row.preco), descricao: row.descricao || "", disponivel: Boolean(row.disponivel) };
}

async function lerCardapio() {
  const db = await conectarBanco();
  const [rows] = await db.query("SELECT * FROM cardapio ORDER BY id ASC");
  return rows.map(rowToPrato);
}

async function montarPedidoCompleto(row) {
  const db = await conectarBanco();
  const [itens] = await db.query("SELECT * FROM pedido_itens WHERE pedido_id = ? ORDER BY id ASC", [row.id]);
  return {
    id: row.id,
    paymentId: row.payment_id || "",
    criadoEm: new Date(row.criado_em).toISOString(),
    atualizadoEm: new Date(row.atualizado_em).toISOString(),
    statusPagamento: row.status_pagamento,
    statusPedido: row.status_pedido,
    cliente: {
      nome: row.cliente_nome,
      bloco: row.cliente_bloco || "",
      apartamento: row.cliente_apartamento,
      observacao: row.observacao || "",
    },
    pagamento: row.pagamento,
    total: Number(row.total),
    itens: itens.map((item) => ({
      id: item.item_cardapio_id,
      nome: item.nome,
      quantidade: Number(item.quantidade),
      preco: Number(item.preco),
      subtotal: Number(item.subtotal),
    })),
  };
}

async function buscarPedidoPorPaymentId(paymentId) {
  const db = await conectarBanco();
  const [rows] = await db.query("SELECT * FROM pedidos WHERE payment_id = ? LIMIT 1", [String(paymentId)]);
  if (!rows.length) return null;
  return montarPedidoCompleto(rows[0]);
}

async function listarPedidos() {
  const db = await conectarBanco();
  const [rows] = await db.query("SELECT * FROM pedidos ORDER BY criado_em DESC");
  const pedidos = [];
  for (const row of rows) pedidos.push(await montarPedidoCompleto(row));
  return pedidos;
}

function validarSenha(req) {
  const senha = req.headers["x-admin-senha"];
  return senha && String(senha) === ADMIN_SENHA;
}

function validarPrato(prato) {
  if (!String(prato.nome || "").trim()) return "Nome obrigatório.";
  if (!Number(prato.preco) || Number(prato.preco) <= 0) return "Preço inválido.";
  return "";
}

async function validarPedido(pedido) {
  if (!pedido) return "Pedido não informado.";
  if (!pedido.cliente) return "Cliente não informado.";
  if (!String(pedido.cliente.nome || "").trim()) return "Nome obrigatório.";
  if (!String(pedido.cliente.apartamento || "").trim()) return "Apartamento obrigatório.";
  if (!Array.isArray(pedido.itens) || pedido.itens.length === 0) return "Pedido sem itens.";

  const cardapio = await lerCardapio();
  let totalCalculado = 0;

  for (const item of pedido.itens) {
    const pratoServidor = cardapio.find((p) => Number(p.id) === Number(item.id));
    if (!pratoServidor) return `Item não encontrado: ${item.nome || item.id}.`;
    if (!pratoServidor.disponivel) return `Item esgotado: ${pratoServidor.nome}.`;
    const quantidade = Number(item.quantidade || 0);
    if (quantidade <= 0) return `Quantidade inválida para ${pratoServidor.nome}.`;
    totalCalculado += quantidade * Number(pratoServidor.preco);
  }

  const totalRecebido = Number(pedido.total || 0);
  if (Math.abs(totalCalculado - totalRecebido) > 0.01) {
    return `Total divergente. Recebido ${moeda(totalRecebido)}, calculado ${moeda(totalCalculado)}. Atualize a página e tente novamente.`;
  }
  return "";
}

function montarDescricao(pedido) {
  const itens = pedido.itens.map((item) => `${item.quantidade}x ${item.nome}`).join(", ");
  return `Feijoada da Dedê - ${itens}`.slice(0, 255);
}

function normalizarPedidoParaSalvar({ pedido, paymentId, statusPagamento, statusPedido = "novo" }) {
  return {
    id: crypto.randomUUID(),
    paymentId: String(paymentId || ""),
    criadoEm: new Date(),
    atualizadoEm: new Date(),
    statusPagamento,
    statusPedido,
    cliente: {
      nome: pedido.cliente.nome,
      bloco: pedido.cliente.bloco || "",
      apartamento: pedido.cliente.apartamento,
      observacao: pedido.cliente.observacao || "",
    },
    pagamento: pedido.pagamento || "Pix",
    total: Number(pedido.total || 0),
    itens: pedido.itens.map((item) => ({
      id: item.id,
      nome: item.nome,
      quantidade: Number(item.quantidade),
      preco: Number(item.preco),
      subtotal: Number(item.subtotal),
    })),
  };
}

async function salvarPedidoNovo(pedidoSalvo) {
  const db = await conectarBanco();
  const conn = await db.getConnection();
  try {
    await conn.beginTransaction();
    await conn.query(
      `INSERT INTO pedidos (
        id, payment_id, criado_em, atualizado_em, status_pagamento, status_pedido,
        cliente_nome, cliente_bloco, cliente_apartamento, observacao, pagamento, total
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        pedidoSalvo.id, pedidoSalvo.paymentId || null, pedidoSalvo.criadoEm, pedidoSalvo.atualizadoEm,
        pedidoSalvo.statusPagamento, pedidoSalvo.statusPedido, pedidoSalvo.cliente.nome,
        pedidoSalvo.cliente.bloco, pedidoSalvo.cliente.apartamento, pedidoSalvo.cliente.observacao,
        pedidoSalvo.pagamento, pedidoSalvo.total,
      ]
    );
    for (const item of pedidoSalvo.itens) {
      await conn.query(
        `INSERT INTO pedido_itens (pedido_id, item_cardapio_id, nome, quantidade, preco, subtotal)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [pedidoSalvo.id, item.id || null, item.nome, item.quantidade, item.preco, item.subtotal]
      );
    }
    await conn.commit();
    return pedidoSalvo;
  } catch (erro) {
    await conn.rollback();
    throw erro;
  } finally {
    conn.release();
  }
}

async function upsertPedidoPorPaymentId({ pedido, paymentId, statusPagamento, statusPedido }) {
  const existente = await buscarPedidoPorPaymentId(paymentId);
  if (existente) {
    const db = await conectarBanco();
    await db.query(
      "UPDATE pedidos SET status_pagamento = ?, status_pedido = ?, atualizado_em = NOW() WHERE payment_id = ?",
      [statusPagamento || existente.statusPagamento, statusPedido || existente.statusPedido, String(paymentId)]
    );
    return buscarPedidoPorPaymentId(paymentId);
  }
  return salvarPedidoNovo(normalizarPedidoParaSalvar({ pedido, paymentId, statusPagamento, statusPedido: statusPedido || "novo" }));
}

async function mercadoPagoFetch(endpoint, options = {}) {
  if (!ACCESS_TOKEN) throw new Error("MERCADO_PAGO_ACCESS_TOKEN não configurado no .env");
  const resposta = await fetch(`https://api.mercadopago.com${endpoint}`, {
    ...options,
    headers: { Authorization: `Bearer ${ACCESS_TOKEN}`, "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const texto = await resposta.text();
  let dados = null;
  try { dados = texto ? JSON.parse(texto) : null; } catch { dados = { raw: texto }; }
  if (!resposta.ok) {
    const detalhe = dados?.message || dados?.error || texto || "Erro desconhecido";
    throw new Error(`Mercado Pago retornou erro ${resposta.status}: ${detalhe}`);
  }
  return dados;
}

app.get("/api/health", async (req, res) => {
  try {
    const db = await conectarBanco();
    await db.query("SELECT 1");
    res.json({ ok: true, db: true });
  } catch (erro) {
    res.status(500).json({ ok: false, erro: erro.message });
  }
});

app.get("/api/cardapio", async (req, res) => {
  try { res.json(await lerCardapio()); }
  catch (erro) { res.status(500).json({ erro: "Não foi possível carregar o cardápio.", detalhe: erro.message }); }
});

app.post("/api/admin/login", (req, res) => {
  if (String(req.body?.senha || "") !== ADMIN_SENHA) return res.status(401).json({ erro: "Senha inválida." });
  res.json({ ok: true });
});

app.post("/api/admin/cardapio", async (req, res) => {
  if (!validarSenha(req)) return res.status(401).json({ erro: "Não autorizado." });
  try {
    const prato = req.body || {};
    const erro = validarPrato(prato);
    if (erro) return res.status(400).json({ erro });
    const db = await conectarBanco();
    const [result] = await db.query(
      "INSERT INTO cardapio (nome, preco, descricao, disponivel) VALUES (?, ?, ?, ?)",
      [String(prato.nome).trim(), Number(prato.preco), String(prato.descricao || "").trim(), prato.disponivel !== false ? 1 : 0]
    );
    res.status(201).json({ id: result.insertId, nome: prato.nome, preco: Number(prato.preco), descricao: prato.descricao || "", disponivel: prato.disponivel !== false });
  } catch (erro) { res.status(500).json({ erro: "Não foi possível adicionar prato.", detalhe: erro.message }); }
});

app.put("/api/admin/cardapio/:id", async (req, res) => {
  if (!validarSenha(req)) return res.status(401).json({ erro: "Não autorizado." });
  try {
    const prato = req.body || {};
    const erro = validarPrato(prato);
    if (erro) return res.status(400).json({ erro });
    const db = await conectarBanco();
    const [result] = await db.query(
      "UPDATE cardapio SET nome = ?, preco = ?, descricao = ?, disponivel = ? WHERE id = ?",
      [String(prato.nome).trim(), Number(prato.preco), String(prato.descricao || "").trim(), Boolean(prato.disponivel) ? 1 : 0, Number(req.params.id)]
    );
    if (!result.affectedRows) return res.status(404).json({ erro: "Prato não encontrado." });
    res.json({ id: Number(req.params.id), nome: prato.nome, preco: Number(prato.preco), descricao: prato.descricao || "", disponivel: Boolean(prato.disponivel) });
  } catch (erro) { res.status(500).json({ erro: "Não foi possível atualizar prato.", detalhe: erro.message }); }
});

app.delete("/api/admin/cardapio/:id", async (req, res) => {
  if (!validarSenha(req)) return res.status(401).json({ erro: "Não autorizado." });
  try {
    const db = await conectarBanco();
    const [result] = await db.query("DELETE FROM cardapio WHERE id = ?", [Number(req.params.id)]);
    if (!result.affectedRows) return res.status(404).json({ erro: "Prato não encontrado." });
    res.json({ ok: true });
  } catch (erro) { res.status(500).json({ erro: "Não foi possível remover prato.", detalhe: erro.message }); }
});

app.get("/api/admin/pedidos", async (req, res) => {
  if (!validarSenha(req)) return res.status(401).json({ erro: "Não autorizado." });
  try { res.json(await listarPedidos()); }
  catch (erro) { res.status(500).json({ erro: "Não foi possível listar pedidos.", detalhe: erro.message }); }
});

app.put("/api/admin/pedidos/:id/status", async (req, res) => {
  if (!validarSenha(req)) return res.status(401).json({ erro: "Não autorizado." });
  try {
    const statusPedido = String(req.body?.statusPedido || "").trim();
    const permitidos = ["novo", "em_preparo", "pronto", "entregue", "cancelado"];
    if (!permitidos.includes(statusPedido)) return res.status(400).json({ erro: "Status inválido." });
    const db = await conectarBanco();
    const [result] = await db.query("UPDATE pedidos SET status_pedido = ?, atualizado_em = NOW() WHERE id = ?", [statusPedido, req.params.id]);
    if (!result.affectedRows) return res.status(404).json({ erro: "Pedido não encontrado." });
    const [rows] = await db.query("SELECT * FROM pedidos WHERE id = ?", [req.params.id]);
    res.json(await montarPedidoCompleto(rows[0]));
  } catch (erro) { res.status(500).json({ erro: "Não foi possível atualizar pedido.", detalhe: erro.message }); }
});

app.post("/api/admin/pedidos/teste", async (req, res) => {
  if (!validarSenha(req)) return res.status(401).json({ erro: "Não autorizado." });
  try {
    const pedidoTeste = {
      cliente: { nome: "Cliente Teste", bloco: "A", apartamento: "101", observacao: "Pedido criado pelo botão de teste do admin" },
      pagamento: "Pix",
      total: 20,
      itens: [{ id: 1, nome: "Feijoada Individual", quantidade: 1, preco: 20, subtotal: 20 }],
    };
    const pedidoSalvo = normalizarPedidoParaSalvar({ pedido: pedidoTeste, paymentId: `teste-${Date.now()}`, statusPagamento: "pago_via_pix", statusPedido: "novo" });
    await salvarPedidoNovo(pedidoSalvo);
    res.status(201).json(pedidoSalvo);
  } catch (erro) { res.status(500).json({ erro: "Não foi possível criar pedido de teste.", detalhe: erro.message }); }
});

app.post("/api/admin/pedidos/manual", async (req, res) => {
  if (!validarSenha(req)) return res.status(401).json({ erro: "Não autorizado." });
  try {
    const erro = await validarPedido(req.body);
    if (erro) return res.status(400).json({ erro });
    const pedidoSalvo = normalizarPedidoParaSalvar({ pedido: req.body, paymentId: "", statusPagamento: req.body.pagamento === "Pix" ? "pix_manual" : "pagamento_na_entrega" });
    await salvarPedidoNovo(pedidoSalvo);
    res.status(201).json(pedidoSalvo);
  } catch (erro) { res.status(500).json({ erro: "Não foi possível salvar pedido manual.", detalhe: erro.message }); }
});


app.post("/api/pedidos/na-entrega", async (req, res) => {
  try {
    const pedido = req.body;

    if (pedido && pedido.pagamento === "Pix") {
      return res.status(400).json({ erro: "Pedidos Pix devem usar /api/criar-pix." });
    }

    const erro = await validarPedido(pedido);
    if (erro) return res.status(400).json({ erro });

    const pedidoSalvo = normalizarPedidoParaSalvar({
      pedido,
      paymentId: `entrega-${Date.now()}-${Math.floor(Math.random() * 10000)}`,
      statusPagamento: "pagamento_na_entrega",
      statusPedido: "novo",
    });

    await salvarPedidoNovo(pedidoSalvo);
    res.status(201).json(pedidoSalvo);
  } catch (erro) {
    console.error("Erro ao salvar pedido na entrega:", erro);
    res.status(500).json({ erro: "Não foi possível salvar pedido na entrega.", detalhe: erro.message });
  }
});

app.post("/api/criar-pix", async (req, res) => {
  try {
    const pedido = req.body;
    const erro = await validarPedido(pedido);
    if (erro) return res.status(400).json({ erro });
    const idempotencyKey = crypto.randomUUID();
    const pagamento = await mercadoPagoFetch("/v1/payments", {
      method: "POST",
      headers: { "X-Idempotency-Key": idempotencyKey },
      body: JSON.stringify({
        transaction_amount: Number(Number(pedido.total).toFixed(2)),
        description: montarDescricao(pedido),
        payment_method_id: "pix",
        external_reference: idempotencyKey,
        payer: { email: "feijoadadede@gmail.com", first_name: String(pedido.cliente.nome || "Cliente").slice(0, 60) },
        metadata: { cliente_nome: pedido.cliente.nome, bloco: pedido.cliente.bloco || "", apartamento: pedido.cliente.apartamento, observacao: pedido.cliente.observacao || "", whatsapp_destino: "5591982631078" },
      }),
    });
    const transactionData = pagamento?.point_of_interaction?.transaction_data || {};
    if (!transactionData.qr_code) return res.status(500).json({ erro: "Mercado Pago não retornou Pix copia e cola.", mercadoPagoStatus: pagamento.status });
    await upsertPedidoPorPaymentId({ pedido, paymentId: String(pagamento.id), statusPagamento: pagamento.status === "approved" ? "pago_via_pix" : "aguardando_pix", statusPedido: "novo" });
    res.status(201).json({ pedidoId: String(pagamento.id), paymentId: String(pagamento.id), status: pagamento.status, copiaECola: transactionData.qr_code, qrCodeBase64: transactionData.qr_code_base64 || "", ticketUrl: transactionData.ticket_url || "" });
  } catch (erro) { res.status(500).json({ erro: "Não foi possível criar o Pix.", detalhe: erro.message }); }
});

app.post("/api/pedidos/confirmar", async (req, res) => {
  try {
    const { paymentId, pedido } = req.body || {};
    const paymentIdLimpo = String(paymentId || "").replace(/\D/g, "");
    if (!paymentIdLimpo) return res.status(400).json({ erro: "ID do pagamento inválido." });
    const erro = await validarPedido(pedido);
    if (erro) return res.status(400).json({ erro });
    const pagamento = await mercadoPagoFetch(`/v1/payments/${paymentIdLimpo}`, { method: "GET" });
    if (pagamento.status !== "approved") return res.status(400).json({ erro: "Pagamento ainda não aprovado.", status: pagamento.status });
    const pedidoSalvo = await upsertPedidoPorPaymentId({ pedido, paymentId: paymentIdLimpo, statusPagamento: "pago_via_pix", statusPedido: "novo" });
    res.status(201).json(pedidoSalvo);
  } catch (erro) { res.status(500).json({ erro: "Não foi possível confirmar pedido.", detalhe: erro.message }); }
});

app.get("/api/pedidos/:paymentId/status", async (req, res) => {
  try {
    const paymentId = String(req.params.paymentId || "").replace(/\D/g, "");
    if (!paymentId) return res.status(400).json({ erro: "ID do pagamento inválido." });
    const pagamento = await mercadoPagoFetch(`/v1/payments/${paymentId}`, { method: "GET" });
    if (pagamento.status === "approved") {
      const db = await conectarBanco();
      await db.query("UPDATE pedidos SET status_pagamento = 'pago_via_pix', atualizado_em = NOW() WHERE payment_id = ?", [paymentId]);
    }
    res.json({ paymentId: String(pagamento.id), status: pagamento.status, statusDetail: pagamento.status_detail, pago: pagamento.status === "approved" });
  } catch (erro) { res.status(500).json({ erro: "Não foi possível consultar o status do pagamento.", detalhe: erro.message }); }
});



app.post("/api/webhook", async (req, res) => {
  const paymentId = String(
    req.body?.data?.id ||
    req.body?.id ||
    req.query?.id ||
    ""
  ).replace(/\D/g, "");

  try {
    console.log("Webhook Mercado Pago recebido:", JSON.stringify(req.body));

    const tipo = req.body?.type || req.body?.topic || req.query?.type || req.query?.topic;

    if (tipo && tipo !== "payment") {
      return res.sendStatus(200);
    }

    if (!paymentId) {
      console.log("Webhook sem paymentId. Respondendo OK.");
      return res.sendStatus(200);
    }

    let pagamento;

    try {
      pagamento = await mercadoPagoFetch(`/v1/payments/${paymentId}`, { method: "GET" });
    } catch (erroConsulta) {
      console.warn(
        `Não foi possível consultar pagamento ${paymentId}. Pode ser simulação do Mercado Pago.`,
        erroConsulta.message
      );
      return res.sendStatus(200);
    }

    if (pagamento.status === "approved") {
      const db = await conectarBanco();
      const [result] = await db.query(
        "UPDATE pedidos SET status_pagamento = 'pago_via_pix', atualizado_em = NOW() WHERE payment_id = ?",
        [paymentId]
      );

      console.log(`Pagamento ${paymentId} aprovado. Pedidos atualizados: ${result.affectedRows}`);
    } else {
      console.log(`Pagamento ${paymentId} recebido com status: ${pagamento.status}`);
    }

    return res.sendStatus(200);
  } catch (erro) {
    console.error(`Erro inesperado no webhook para paymentId=${paymentId}:`, erro);
    return res.sendStatus(200);
  }
});

app.get("/api/webhook", (req, res) => {
  res.json({
    ok: true,
    rota: "/api/webhook",
    metodoCorreto: "POST",
    mensagem: "Webhook online"
  });
});


app.get("/admin", (req, res) => res.sendFile(path.join(__dirname, "public", "admin.html")));
app.get("*", (req, res) => res.sendFile(path.join(__dirname, "public", "index.html")));

async function startServer() {
  await initDb();
  app.listen(PORT, () => {
    console.log(`Feijoada da Dedê rodando na porta ${PORT}`);
    console.log(`Admin: /admin`);
  });
}

if (require.main === module) {
  startServer().catch((erro) => {
    console.error("Erro ao iniciar servidor:", erro);
    process.exit(1);
  });
}

module.exports = { app, validarPrato, montarDescricao, normalizarPedidoParaSalvar, initDb, startServer };
