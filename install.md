# Bot WhatsApp - Verificador de Inativos

## Objetivo
Criar um bot para WhatsApp que monitore grupos e identifique membros inativos.

## Tecnologias
- Node.js
- whatsapp-web.js
- qrcode-terminal
- fs-extra
- dayjs

---

# Funções do Bot

## 1. Monitorar mensagens
O bot deve:
- detectar mensagens em grupos
- salvar:
  - id do usuário
  - data da última mensagem
  - quantidade de mensagens

---

## 2. Comando /inativos

### Exemplo:
```txt
/inativos 30
```

### Resultado:
Mostrar lista de membros que estão sem falar há 30 dias.

Exemplo:
```txt
📋 Membros inativos há 30 dias:

• João - 45 dias
• Carlos - 31 dias
```

---

## 3. Banco de dados

Salvar tudo em:
```txt
atividade.json
```

Estrutura:
```json
{
  "Grupo Teste": {
    "551199999999@c.us": {
      "ultimaMensagem": "2026-05-18T10:00:00",
      "totalMensagens": 25
    }
  }
}
```

---

## 4. Requisitos

- funcionar em múltiplos grupos
- funcionar no Windows
- autenticação via QR Code
- não remover membros automaticamente
- apenas listar inativos

---

## 5. Estrutura esperada

```txt
bot-whatsapp/
│
├── index.js
├── atividade.json
├── package.json
└── .wwebjs_auth/
```

---

## 6. Dependências

Instalar:
```bash
npm install whatsapp-web.js qrcode-terminal fs-extra dayjs
```

---

## 7. Inicialização

Comando:
```bash
node index.js
```

---

## 8. Extras futuros

- comando /ranking
- ignorar admins
- exportar Excel
- painel web