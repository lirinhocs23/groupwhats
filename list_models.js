require('dotenv').config({ path: 'C:/Users/Lirinhocs/Downloads/groupwhats/.env' });
const apiKey = process.env.GEMINI_API_KEY;

async function listModels() {
  try {
    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`);
    const data = await res.json();
    console.log("Modelos suportados:");
    data.models.forEach(m => {
      if(m.name.includes('gemini-1.5') || m.name.includes('gemini-2.0') || m.name.includes('flash')) {
        console.log(m.name, " - suporta:", m.supportedGenerationMethods);
      }
    });
  } catch(e) {
    console.error(e);
  }
}

listModels();
