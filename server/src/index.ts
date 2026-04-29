import express from 'express';
import { createServer } from 'http';
import cookieParser from 'cookie-parser';
import config from './config';
import { pool } from './db/client';
import { createAuthRouter } from './routes/auth';
import { createConfigRouter } from './routes/config';

export const app = express();
app.use(express.json());
app.use(cookieParser());

app.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'wr-app-server', time: new Date().toISOString() });
});

app.use('/api/auth', createAuthRouter(pool));
app.use('/api/config', createConfigRouter());

if (require.main === module) {
  const server = createServer(app);
  server.listen(config.port, () => {
    console.log(`[wr-server] Listening on http://localhost:${config.port}`);
  });
}
