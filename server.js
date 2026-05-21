   }
 }
 
 /**
  * Fila sequencial assíncrona para exclusão de mensagens
  */
 async function processarFilaDelecao() {
   if (delecaoEmAndamento) return;
   delecaoEmAndamento = true;
 
   while (filaDelecao.length > 0) {
     const msg = filaDelecao.shift();
     try {
       await msg.delete(true);
       console.log(`🗑️ Mensagem proibida apagada no SaaS de forma sequencial na fila.`);
     } catch (err) {
       console.error('❌ Erro ao apagar mensagem na fila do SaaS:', err.message);
     }
     // Aguarda um intervalo de estabilização de 400ms para o DOM do Puppeteer
     await new Promise(resolve => setTimeout(resolve, 400));
   }
 
   delecaoEmAndamento = false;
 }
 
 /**
  * Deleta uma mensagem do WhatsApp de forma serializada (fila) para evitar
  * colisões de cliques e popups concorrentes no DOM do Puppeteer.
  */
 async function deletarMensagemComFila(msg) {
   filaDelecao.push(msg);
