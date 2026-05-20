const fs = require('fs');

async function testUpload() {
  const base64Data = Buffer.from('AAAA').toString('base64');
  const mimeType = 'video/mp4';
  const apiKey = 'FAKE_KEY';
  
  const uploadUrl = `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${apiKey}`;
  const uploadRes = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': mimeType,
      'X-Goog-Upload-Protocol': 'raw',
      'X-Goog-Upload-Command': 'upload, finalize'
    },
    body: Buffer.from(base64Data, 'base64')
  });
  
  console.log(uploadRes.status);
  const json = await uploadRes.json();
  console.log(json);
}

testUpload();
