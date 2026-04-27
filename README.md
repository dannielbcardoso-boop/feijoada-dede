# Feijoada da Dedê — Hostinger + MySQL

Versão adaptada para o plano da Hostinger com **Node.js** e **MySQL**.

## O que tem

- Site do cliente
- Pix automático Mercado Pago
- Admin em `/admin`
- Cardápio salvo no MySQL
- Pedidos salvos no MySQL
- Abas: Ativos, Prontos, Entregues, Cancelados, Todos
- Cupom térmico 58mm/80mm
- Alerta sonoro e Enter para imprimir

## .env

Crie um arquivo `.env` com:

```txt
MERCADO_PAGO_ACCESS_TOKEN=APP_USR_SEU_ACCESS_TOKEN_AQUI
ADMIN_SENHA=dede123
PORT=3000

DB_HOST=localhost
DB_PORT=3306
DB_USER=seu_usuario_mysql
DB_PASSWORD=sua_senha_mysql
DB_NAME=seu_banco_mysql
```

Na Hostinger, pegue os dados do banco em **Bancos de Dados MySQL**.

## Rodar

```bash
npm install
npm start
```

## Testar saúde

Abra:

```txt
/seusite/api/health
```

Se o banco estiver conectado, deve retornar:

```json
{"ok":true,"db":true}
```

## Importante

Na primeira inicialização, o sistema cria automaticamente as tabelas:

- cardapio
- pedidos
- pedido_itens

E também insere o cardápio inicial, caso esteja vazio.


## Correção 2.0.1 — pedidos em dinheiro/cartão

Antes, pedido com pagamento em dinheiro/cartão tentava salvar usando senha de admin no navegador do cliente.
Isso fazia o pedido abrir no WhatsApp, mas não aparecer no painel.

Agora o cliente usa a rota pública:

```txt
POST /api/pedidos/na-entrega
```

Assim pedidos em dinheiro/cartão aparecem no admin como `pagamento_na_entrega`.
