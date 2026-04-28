import express from 'express';
import { createServer } from 'http';

const PORT = Number(process.env.PORT || 3001);

export const app = express();
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'wr-app-server', time: new Date().toISOString() });
});

if (require.main === module) {
  const server = createServer(app);
  server.listen(PORT, () => {
    console.log(`[wr-server] Listening on http://localhost:${PORT}`);
  });
}
