VERSÃO CORRIGIDA - WEBHOOK PIX

Depois de subir no GitHub e fazer Redeploy no Railway:

1. No Mercado Pago, use a URL:
   https://feijoada-dede-production.up.railway.app/api/webhook

2. Marque o evento:
   Pagamentos

3. A simulação do Mercado Pago pode usar ID falso.
   Esta versão responde OK para simulação e não gera 500.

4. Pix real aprovado deve atualizar:
   AGUARDANDO PIX -> PAGO VIA PIX
