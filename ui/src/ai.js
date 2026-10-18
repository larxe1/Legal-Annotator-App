export async function callGemini(apiKey, systemInstruction, prompt, schema = null, maxRetries = 3) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent?key=${apiKey}`;
  
  const payload = {
    system_instruction: {
      parts: [{ text: systemInstruction }]
    },
    contents: [{
      parts: [{ text: prompt }]
    }],
    generationConfig: {
      temperature: 0.2
    }
  };

  if (schema) {
    payload.generationConfig.response_mime_type = "application/json";
    payload.generationConfig.response_schema = schema;
  }

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });

      if (!res.ok) {
        let err = 'API Error';
        try { const data = await res.json(); err = data.error?.message || err; } catch {}
        
        if ((res.status === 503 || res.status === 429) && attempt < maxRetries) {
          throw new Error(`RETRY: ${err}`);
        }
        throw new Error(err);
      }

      const data = await res.json();
      const text = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!text) throw new Error("Empty response from AI");
      
      if (schema) {
        try {
          return JSON.parse(text);
        } catch (e) {
          throw new Error("Invalid JSON returned by AI");
        }
      }
      
      return text;
      
    } catch (err) {
      if (err.message.startsWith('RETRY:') && attempt < maxRetries) {
        const delayMs = Math.pow(2, attempt) * 2000;
        console.warn(`Gemini API busy (attempt ${attempt + 1}). Retrying in ${delayMs}ms...`);
        await new Promise(r => setTimeout(r, delayMs));
      } else {
        throw new Error(err.message.replace('RETRY: ', ''));
      }
    }
  }
}

