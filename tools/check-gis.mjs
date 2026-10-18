import http from 'node:http';
import { spawn } from 'node:child_process';

const srv = http.createServer((req, res) => {
  if (req.url.startsWith('/done?')) {
    console.log('GIS_URL:', decodeURIComponent(req.url.slice(6)));
    process.exit(0);
  }
  res.writeHead(200, { 'Content-Type': 'text/html' });
  res.end(`<!DOCTYPE html><script src="https://accounts.google.com/gsi/client" onload="go()"></script><script>
    function go() {
      window.open = (u) => {
        fetch('/done?' + encodeURIComponent(u));
        return { closed: false, focus(){}, close(){} };
      };
      const c = google.accounts.oauth2.initTokenClient({
        client_id: '572567924584-qj0m9fkkkjsrgva6dj32or7esbgkqvql.apps.googleusercontent.com',
        scope: 'https://www.googleapis.com/auth/drive.file',
        callback: () => {}
      });
      c.requestAccessToken({ prompt: 'select_account' });
    }
  </script>`);
});

srv.listen(0, '127.0.0.1', () => {
  const p = srv.address().port;
  spawn('C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', [
    '--headless=new',
    '--disable-gpu',
    `http://localhost:${p}`,
  ]);
});
