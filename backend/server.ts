import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import path from 'path';
import { getCompositeSignal } from './signals';

dotenv.config();

const app = express();
app.use(cors());

const DEFAULT_SYMBOLS = (process.env.WATCHLIST ?? 'SPY,QQQ,AAPL,MSFT,NVDA').split(',')
  .map((symbol) => symbol.trim().toUpperCase())
  .filter(Boolean);

type CachedSignal = {
  updatedAt: number;
  payload: Awaited<ReturnType<typeof getCompositeSignal>>;
};

const cache = new Map<string, CachedSignal>();
const CACHE_TTL_MS = Number(process.env.SIGNAL_CACHE_MS ?? 2 * 60 * 1000);

async function loadSignal(symbol: string) {
  const cached = cache.get(symbol);
  const now = Date.now();
  if (cached && now - cached.updatedAt < CACHE_TTL_MS) {
    return cached.payload;
  }

  const payload = await getCompositeSignal(symbol);
  cache.set(symbol, { payload, updatedAt: now });
  return payload;
}

app.get('/api/picks', async (req, res) => {
  const querySymbols = (req.query.symbols as string | undefined)
    ?.split(',')
    .map((symbol) => symbol.trim().toUpperCase())
    .filter(Boolean);

  const symbols = querySymbols && querySymbols.length > 0 ? querySymbols : DEFAULT_SYMBOLS;

  try {
    const picks = await Promise.all(
      symbols.map(async (symbol) => {
        try {
          return await loadSignal(symbol);
        } catch (error) {
          console.error(`Unable to build signal for ${symbol}:`, error);
          return {
            symbol,
            score: 0,
            updatedAt: new Date().toISOString(),
            latestPrice: null,
            explanation: 'Signal unavailable due to upstream data error.',
            signals: {
              smaTrend: null,
              rsi: null,
              macd: null,
              bollinger: null,
              volumeSurge: null,
              sentiment: null,
              ivRank: null,
            },
            details: [],
          };
        }
      })
    );

    const sorted = picks.slice().sort((a, b) => b.score - a.score);

    res.json({
      updatedAt: new Date().toISOString(),
      symbols,
      picks: sorted,
    });
  } catch (error) {
    console.error('Failed to generate picks', error);
    res.status(500).json({ message: 'Unable to generate picks at this time.' });
  }
});

const staticDir = path.resolve(__dirname, '..');

app.use(express.static(staticDir));

app.get('*', (req, res) => {
  res.sendFile(path.join(staticDir, 'index.html'));
});

const PORT = Number(process.env.PORT ?? 3000);
app.listen(PORT, () => {
  console.log(`AI Trading server listening on http://localhost:${PORT}`);
});
