# 🤖 Bot de Gerenciamento de Inativos & Moderação do WhatsApp
> *Manual Completo de Utilização, Comandos e Operação Multi-grupo*

Este bot foi projetado para monitorar a atividade de membros em múltiplos grupos do WhatsApp de forma 100% dinâmica, oferecendo relatórios de inatividade com marcações automáticas e moderação de elite (banimentos) exclusiva para o administrador master.

---

## 🚀 1. Inicialização do Bot

Toda vez que você iniciar seu computador ou precisar ligar o bot, siga este fluxo simples no terminal:

1. Abra o terminal **PowerShell** no Windows na pasta do projeto:
   `c:\Users\Lirinhocs\Downloads\groupwhats`
2. Digite o comando para iniciar:
   ```powershell
   node index.js
   ```
3. O bot iniciará, lerá a sua sessão salva automaticamente e mostrará:
   `✅ Bot conectado com sucesso!`

---

## 👥 2. Como Usar em Novos Grupos (Multi-grupo)

O bot é **100% automático** e suporta múltiplos grupos simultâneos sem necessidade de configurações adicionais.

1. **Adicione o número do Bot** no novo grupo que deseja gerenciar.
2. **Torne o Bot Administrador** do novo grupo (necessário para que ele tenha poder de banimento e possa ver os participantes corretamente).
3. **Escreva qualquer mensagem** no grupo (ou espere que alguém fale) para que o bot registre o grupo no banco de dados.
4. **Pronto!** O monitoramento já estará ativo para esse novo grupo.

---

## 📊 3. Comando: Verificar Inativos (`/inativos`)

Este comando calcula quem está sem mandar mensagens no grupo pelo tempo estipulado.

* **Quem pode usar**: Você (Dono do bot) **OU** qualquer outro administrador do grupo.
* **Membros comuns**: Se tentarem usar, o bot negará o acesso na hora.
* **Segurança extra**: O bot **ignora automaticamente todos os administradores** na lista de inativos para que eles nunca sejam listados ou incomodados.

### Formas de Uso:
| Comando | O que ele faz |
| :--- | :--- |
| `/inativos 7` | **Automático**: Se a lista for pequena (até 10 pessoas), manda no grupo marcando todos com `@` real. Se for grande (mais de 10 pessoas), avisa no grupo e envia o relatório com as marcações **no privado (PV)** do admin que solicitou para evitar poluição visual e risco de ban do WhatsApp. |
| `/inativos 7 pv` | **Forçar Privado**: Envia o relatório completo direto no privado do admin que solicitou (útil para relatórios discretos). |
| `/inativos 7 gp` | **Forçar Grupo**: Manda a lista inteira direto no grupo marcando todo mundo, independente do tamanho. |

---

## 🚫 4. Comando: Banimento Administrativo (`/ban`)

Remove membros indesejados ou infratores do grupo no mesmo segundo com uma notificação formal.

* **Quem pode usar**: **Apenas você (Dono do bot/Bot Master)**. Outros administradores do grupo não têm acesso a este comando pelo bot.
* **Requisito**: O bot precisa ser Administrador do grupo.

### Formas de Uso:
1. **Banir por Menção** (O método mais fácil e seguro):
   ```
   /ban @MembroInfrator
   ```
2. **Banir por Número** (Caso a pessoa não esteja nos contatos ou você tenha apenas o número com DDD):
   ```
   /ban 5573999999999
   ```

*Quando o ban é executado, o bot remove o membro fisicamente e envia a mensagem institucional de aviso:*
> "🚫 `@membro` foi removido do grupo por violação das regras estabelecidas."

---

## 📊 5. Comando: Relatório Seguro em Documento TXT (`/relatorio`)

Este comando gera uma análise profunda de engajamento no grupo de forma 100% imune a banimentos do WhatsApp. Em vez de enviar um textão cheio de menções no chat (que causa ban), ele cria um arquivo de texto `.txt` organizado e te envia como **documento** no chat privado de forma discreta.

* **Quem pode usar**: Você (Dono do bot) **OU** qualquer outro administrador do grupo.
* **Membros comuns**: Negado na hora pelo bot.
* **Segurança**: Risco zero de banimento, pois usa números puros no documento anexado sem disparar alertas de spam.

### Formas de Uso:
```
/relatorio <dias_inativos> <limite_mensagens>
```
* **Exemplo:** `/relatorio 30 3`
  * Gera a lista dividida em:
    * **🔥 Membros Ativos**: Quem fala bastante.
    * **🤫 Observadores/Silenciosos**: Quem mandou de 1 até 3 mensagens (só espiando o grupo).
    * **👻 Fantasmas/Inativos**: Quem tem 0 mensagens ou não fala há mais de 30 dias.
  * O bot cria o arquivo `relatorio_grupo_Fd.txt` e te entrega anexado no seu privado!

---

## 👻 6. Comando: Filtrar Membros Silenciosos (`/fantasmas`)

Uma listagem direta e rápida no chat para identificar membros que têm uma participação quase nula desde que o monitoramento começou.

* **Quem pode usar**: Administradores e o dono do bot.
* **Exemplo:** `/fantasmas 5` (Lista todos com menos de 5 mensagens enviadas no total).

---

## 🚨 7. Comandos de Emergência (Caso o Chrome trave)

Se você fechar o terminal do bot incorretamente (no "X" da janela) ou o processo travar e der o erro *"The browser is already running..."* ao tentar abrir de novo, execute este comando no PowerShell antes de iniciar o bot:

```powershell
taskkill /F /IM chrome.exe 2>$null; taskkill /F /IM node.exe 2>$null
```
*(Esse comando encerra à força qualquer processo fantasma do Google Chrome ou do Node.js que esteja travando a pasta de sessão do bot).*

---

*Desenvolvido com carinho para máxima estabilidade, segurança e eficiência no gerenciamento de suas comunidades do WhatsApp!* 🌟
