const assert = require("assert");
const { validarPrato, montarDescricao, normalizarPedidoParaSalvar } = require("./server");

assert.strictEqual(validarPrato({ nome: "Arroz", preco: 5 }), "");
assert.ok(validarPrato({ nome: "", preco: 5 }).includes("Nome"));
assert.ok(validarPrato({ nome: "Arroz", preco: 0 }).includes("Preço"));

const pedido = {
  cliente: { nome: "Cliente", bloco: "A", apartamento: "101", observacao: "Sem pimenta" },
  pagamento: "Pix",
  total: 20,
  itens: [{ id: 1, nome: "Feijoada Individual", quantidade: 1, preco: 20, subtotal: 20 }],
};

assert.ok(montarDescricao(pedido).includes("Feijoada da Dedê"));
assert.ok(montarDescricao(pedido).length <= 255);

const salvo = normalizarPedidoParaSalvar({ pedido, paymentId: "123", statusPagamento: "pago_via_pix" });
assert.strictEqual(salvo.paymentId, "123");
assert.strictEqual(salvo.statusPedido, "novo");
assert.strictEqual(salvo.cliente.apartamento, "101");
assert.strictEqual(salvo.itens[0].subtotal, 20);

console.log("Testes básicos passaram. Testes de banco dependem do MySQL configurado no .env.");
