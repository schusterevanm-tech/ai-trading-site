import dotenv from 'dotenv';

dotenv.config();

type PriceBar = {
  date: string;
  close: number;
  volume: number;
};

type SentimentSnapshot = {
  bullishPercent: number;
  bearishPercent: number;
  score: number;
};

type VolatilitySnapshot = {
  currentIv: number;
  lowIv: number;
  highIv: number;
};

export interface IndicatorSignals {
  smaTrend: number | null;
  rsi: number | null;
  macd: number | null;
  bollinger: number | null;
  volumeSurge: number | null;
  sentiment: number | null;
  ivRank: number | null;
}

export interface IndicatorDetail {
  name: string;
  value: string;
  signal: number | null;
}

export interface CompositePick {
  symbol: string;
  score: number;
  updatedAt: string;
  latestPrice: number | null;
  explanation: string;
  signals: IndicatorSignals;
  details: IndicatorDetail[];
}

const ALPHA_VANTAGE_KEY = process.env.ALPHA_VANTAGE_KEY;
const FINNHUB_KEY = process.env.FINNHUB_KEY;
const POLYGON_KEY = process.env.POLYGON_KEY;

function clamp(value: number, min = -1, max = 1): number {
  return Math.max(min, Math.min(max, value));
}

function rollingAverage(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

async function fetchJson(url: string): Promise<any> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Request failed: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function fetchPriceHistory(symbol: string): Promise<PriceBar[]> {
  if (!ALPHA_VANTAGE_KEY) {
    throw new Error('Missing Alpha Vantage API key. Set ALPHA_VANTAGE_KEY in your environment.');
  }

  const url = new URL('https://www.alphavantage.co/query');
  url.searchParams.set('function', 'TIME_SERIES_DAILY_ADJUSTED');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', ALPHA_VANTAGE_KEY);

  const data = await fetchJson(url.toString());
  const series = data['Time Series (Daily)'];
  if (!series) {
    throw new Error(`Alpha Vantage response missing daily time series for ${symbol}`);
  }

  const entries: PriceBar[] = Object.entries(series).map(([date, values]) => {
    const parsed = values as Record<string, string>;
    return {
      date,
      close: Number.parseFloat(parsed['4. close']),
      volume: Number.parseFloat(parsed['6. volume'] ?? parsed['5. volume']),
    };
  });

  return entries
    .filter((bar) => Number.isFinite(bar.close) && Number.isFinite(bar.volume))
    .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
}

async function fetchFundamentals(symbol: string): Promise<Record<string, string>> {
  if (!ALPHA_VANTAGE_KEY) {
    throw new Error('Missing Alpha Vantage API key. Set ALPHA_VANTAGE_KEY in your environment.');
  }

  const url = new URL('https://www.alphavantage.co/query');
  url.searchParams.set('function', 'OVERVIEW');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('apikey', ALPHA_VANTAGE_KEY);

  const data = await fetchJson(url.toString());
  if (!data || Object.keys(data).length === 0) {
    throw new Error(`Alpha Vantage overview not available for ${symbol}`);
  }
  return data;
}

async function fetchSentiment(symbol: string): Promise<SentimentSnapshot | null> {
  if (!FINNHUB_KEY) {
    return null;
  }

  const url = new URL('https://finnhub.io/api/v1/news-sentiment');
  url.searchParams.set('symbol', symbol);
  url.searchParams.set('token', FINNHUB_KEY);

  try {
    const data = await fetchJson(url.toString());
    if (!data?.sentiment) {
      return null;
    }
    const bullishPercent = Number.parseFloat(data.sentiment.bullishPercent ?? '0');
    const bearishPercent = Number.parseFloat(data.sentiment.bearishPercent ?? '0');
    const score = clamp((bullishPercent - bearishPercent) / 100);
    return {
      bullishPercent,
      bearishPercent,
      score,
    };
  } catch (error) {
    console.error('Finnhub sentiment error', error);
    return null;
  }
}

async function fetchVolatility(symbol: string): Promise<VolatilitySnapshot | null> {
  if (!POLYGON_KEY) {
    return null;
  }

  const url = new URL('https://api.polygon.io/v3/reference/options/contracts');
  url.searchParams.set('underlying_ticker', symbol);
  url.searchParams.set('limit', '50');
  url.searchParams.set('sort', 'implied_volatility');
  url.searchParams.set('order', 'desc');
  url.searchParams.set('apiKey', POLYGON_KEY);

  try {
    const data = await fetchJson(url.toString());
    const results: any[] = data?.results ?? [];
    if (results.length === 0) {
      return null;
    }
    const ivValues = results
      .map((result) => Number.parseFloat(result.implied_volatility))
      .filter((value) => Number.isFinite(value));

    if (ivValues.length === 0) {
      return null;
    }

    const currentIv = ivValues[0];
    const highIv = Math.max(...ivValues);
    const lowIv = Math.min(...ivValues);

    return { currentIv, highIv, lowIv };
  } catch (error) {
    console.error('Polygon volatility error', error);
    return null;
  }
}

function calculateSMA(values: number[], period: number): number | null {
  if (values.length < period) {
    return null;
  }
  const slice = values.slice(-period);
  return rollingAverage(slice);
}

function calculateEMA(values: number[], period: number): number | null {
  if (values.length < period) {
    return null;
  }
  const smoothing = 2 / (period + 1);
  let ema = rollingAverage(values.slice(0, period));
  for (let i = period; i < values.length; i += 1) {
    ema = values[i] * smoothing + ema * (1 - smoothing);
  }
  return ema;
}

function calculateRSI(values: number[], period = 14): number | null {
  if (values.length <= period) {
    return null;
  }
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    if (change >= 0) {
      gains += change;
    } else {
      losses += Math.abs(change);
    }
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    avgGain = ((avgGain * (period - 1)) + gain) / period;
    avgLoss = ((avgLoss * (period - 1)) + loss) / period;
  }
  if (avgLoss === 0) {
    return 100;
  }
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function calculateMACD(values: number[]): { macd: number; signal: number; histogram: number } | null {
  if (values.length < 35) {
    return null;
  }
  const shortPeriod = 12;
  const longPeriod = 26;
  const signalPeriod = 9;
  const kShort = 2 / (shortPeriod + 1);
  const kLong = 2 / (longPeriod + 1);
  const macdValues: number[] = [];

  let emaShort = rollingAverage(values.slice(0, shortPeriod));
  let emaLong = rollingAverage(values.slice(0, longPeriod));

  for (let i = longPeriod; i < values.length; i += 1) {
    emaShort = values[i] * kShort + emaShort * (1 - kShort);
    emaLong = values[i] * kLong + emaLong * (1 - kLong);
    macdValues.push(emaShort - emaLong);
  }

  if (macdValues.length < signalPeriod) {
    return null;
  }

  let signal = rollingAverage(macdValues.slice(0, signalPeriod));
  const kSignal = 2 / (signalPeriod + 1);
  for (let i = signalPeriod; i < macdValues.length; i += 1) {
    signal = macdValues[i] * kSignal + signal * (1 - kSignal);
  }

  const macd = macdValues[macdValues.length - 1];
  const histogram = macd - signal;
  return { macd, signal, histogram };
}

function calculateBollinger(values: number[], period = 20, multiplier = 2) {
  if (values.length < period) {
    return null;
  }
  const slice = values.slice(-period);
  const middle = rollingAverage(slice);
  const variance = slice.reduce((sum, value) => sum + (value - middle) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  return {
    middle,
    upper: middle + multiplier * stdDev,
    lower: middle - multiplier * stdDev,
    stdDev,
  };
}

function calculateVolumeSurge(volumes: number[], period = 20): number | null {
  if (volumes.length <= period) {
    return null;
  }
  const recent = volumes[volumes.length - 1];
  const baseline = rollingAverage(volumes.slice(-(period + 1), -1));
  if (!baseline) {
    return null;
  }
  const ratio = recent / baseline;
  return clamp(ratio - 1);
}

function calculateIvRank(snapshot: VolatilitySnapshot | null): number | null {
  if (!snapshot) {
    return null;
  }
  const { currentIv, highIv, lowIv } = snapshot;
  if (!Number.isFinite(currentIv) || !Number.isFinite(highIv) || !Number.isFinite(lowIv) || highIv === lowIv) {
    return null;
  }
  const rank = (currentIv - lowIv) / (highIv - lowIv);
  return clamp(rank * 2 - 1);
}

function sentimentSignal(snapshot: SentimentSnapshot | null): number | null {
  if (!snapshot) {
    return null;
  }
  return clamp(snapshot.score);
}

function macdSignal(macd: { macd: number; signal: number; histogram: number } | null): number | null {
  if (!macd) {
    return null;
  }
  const base = macd.histogram;
  const scale = Math.max(0.01, Math.abs(macd.signal));
  return clamp(base / scale);
}

function bollingerSignal(latestPrice: number | null, bands: ReturnType<typeof calculateBollinger> | null): number | null {
  if (!bands || latestPrice == null) {
    return null;
  }
  const { middle, stdDev } = bands;
  if (stdDev === 0) {
    return 0;
  }
  return clamp((latestPrice - middle) / (2 * stdDev));
}

function smaSignal(sma50: number | null, sma200: number | null): number | null {
  if (sma50 == null || sma200 == null || sma200 === 0) {
    return null;
  }
  return clamp((sma50 - sma200) / sma200);
}

function rsiSignal(rsi: number | null): number | null {
  if (rsi == null) {
    return null;
  }
  return clamp((rsi - 50) / 25);
}

function buildDetails(params: {
  symbol: string;
  latestPrice: number | null;
  sma50: number | null;
  sma200: number | null;
  rsi: number | null;
  macd: { macd: number; signal: number; histogram: number } | null;
  bollinger: ReturnType<typeof calculateBollinger> | null;
  volumeSurge: number | null;
  sentiment: SentimentSnapshot | null;
  ivRank: number | null;
  fundamentals: Record<string, string> | null;
}): IndicatorDetail[] {
  const details: IndicatorDetail[] = [];
  const price = params.latestPrice != null ? `$${params.latestPrice.toFixed(2)}` : 'n/a';
  details.push({ name: 'Last Price', value: price, signal: null });
  if (params.sma50 != null && params.sma200 != null) {
    details.push({
      name: 'SMA50 / SMA200',
      value: `${params.sma50.toFixed(2)} / ${params.sma200.toFixed(2)}`,
      signal: smaSignal(params.sma50, params.sma200),
    });
  }
  if (params.rsi != null) {
    details.push({ name: 'RSI(14)', value: params.rsi.toFixed(1), signal: rsiSignal(params.rsi) });
  }
  if (params.macd) {
    details.push({
      name: 'MACD (Hist)',
      value: params.macd.histogram.toFixed(3),
      signal: macdSignal(params.macd),
    });
  }
  if (params.bollinger) {
    details.push({
      name: 'Bollinger Band',
      value: `${params.bollinger.lower.toFixed(2)} - ${params.bollinger.upper.toFixed(2)}`,
      signal: bollingerSignal(params.latestPrice ?? null, params.bollinger),
    });
  }
  if (params.volumeSurge != null) {
    const percent = (params.volumeSurge * 100).toFixed(1);
    details.push({ name: 'Volume vs Avg', value: `${percent}%`, signal: clamp(params.volumeSurge) });
  }
  if (params.sentiment) {
    const { bullishPercent, bearishPercent } = params.sentiment;
    details.push({
      name: 'Sentiment (Bull/Bear)',
      value: `${bullishPercent.toFixed(1)}% / ${bearishPercent.toFixed(1)}%`,
      signal: sentimentSignal(params.sentiment),
    });
  }
  if (params.ivRank != null) {
    details.push({ name: 'IV Rank', value: (((params.ivRank + 1) / 2) * 100).toFixed(0), signal: params.ivRank });
  }
  if (params.fundamentals) {
    const peRatio = Number.parseFloat(params.fundamentals.PERatio ?? '0');
    const profitMargin = Number.parseFloat(params.fundamentals.ProfitMargin ?? '0');
    if (Number.isFinite(peRatio) && peRatio > 0) {
      details.push({ name: 'P/E Ratio', value: peRatio.toFixed(1), signal: null });
    }
    if (Number.isFinite(profitMargin)) {
      details.push({ name: 'Profit Margin', value: `${(profitMargin * 100).toFixed(1)}%`, signal: null });
    }
  }
  return details;
}

function buildExplanation(signals: IndicatorSignals): string {
  const highlights: string[] = [];
  if (signals.smaTrend != null) {
    if (signals.smaTrend > 0.2) {
      highlights.push('Trend momentum: 50-day moving average is comfortably above the 200-day');
    } else if (signals.smaTrend < -0.2) {
      highlights.push('Downtrend pressure: 50-day average is tracking below the 200-day');
    }
  }
  if (signals.rsi != null) {
    if (signals.rsi > 0.3) {
      highlights.push('RSI momentum remains bullish');
    } else if (signals.rsi < -0.3) {
      highlights.push('RSI shows oversold momentum');
    }
  }
  if (signals.macd != null) {
    if (signals.macd > 0.3) {
      highlights.push('MACD histogram is expanding above the signal line');
    } else if (signals.macd < -0.3) {
      highlights.push('MACD histogram is weakening below the signal line');
    }
  }
  if (signals.volumeSurge != null) {
    if (signals.volumeSurge > 0.3) {
      highlights.push('Volume is expanding versus the 20-day average');
    } else if (signals.volumeSurge < -0.3) {
      highlights.push('Volume is contracting versus the 20-day average');
    }
  }
  if (signals.sentiment != null) {
    if (signals.sentiment > 0.2) {
      highlights.push('News sentiment skewed bullish');
    } else if (signals.sentiment < -0.2) {
      highlights.push('News sentiment skewed cautious');
    }
  }
  if (signals.ivRank != null) {
    if (signals.ivRank > 0.2) {
      highlights.push('Implied volatility running hot relative to its range');
    } else if (signals.ivRank < -0.2) {
      highlights.push('Implied volatility deeply discounted');
    }
  }

  if (highlights.length === 0) {
    return 'Signals are mixed with no single driver dominating the setup.';
  }
  return highlights.join('. ') + '.';
}

function weightedComposite(signals: IndicatorSignals): number {
  const weights: Record<keyof IndicatorSignals, number> = {
    smaTrend: 0.2,
    rsi: 0.15,
    macd: 0.2,
    bollinger: 0.1,
    volumeSurge: 0.1,
    sentiment: 0.15,
    ivRank: 0.1,
  };
  let weightedSum = 0;
  let totalWeight = 0;
  (Object.keys(signals) as (keyof IndicatorSignals)[]).forEach((key) => {
    const value = signals[key];
    if (value != null) {
      weightedSum += value * weights[key];
      totalWeight += weights[key];
    }
  });
  if (totalWeight === 0) {
    return 0;
  }
  return clamp(weightedSum / totalWeight);
}

export async function getCompositeSignal(symbol: string): Promise<CompositePick> {
  const [prices, fundamentals, sentiment, volatility] = await Promise.all([
    fetchPriceHistory(symbol),
    fetchFundamentals(symbol).catch((error) => {
      console.warn(`Fundamentals unavailable for ${symbol}:`, error);
      return null;
    }),
    fetchSentiment(symbol),
    fetchVolatility(symbol),
  ]);

  if (!prices || prices.length === 0) {
    throw new Error(`No price data returned for ${symbol}`);
  }

  const closes = prices.map((bar) => bar.close);
  const volumes = prices.map((bar) => bar.volume);
  const latestPrice = closes[closes.length - 1] ?? null;
  const sma50 = calculateSMA(closes, 50);
  const sma200 = calculateSMA(closes, 200);
  const rsi = calculateRSI(closes);
  const macd = calculateMACD(closes);
  const bollinger = calculateBollinger(closes);
  const volumeSurge = calculateVolumeSurge(volumes);
  const ivRank = calculateIvRank(volatility);

  const indicatorSignals: IndicatorSignals = {
    smaTrend: smaSignal(sma50, sma200),
    rsi: rsiSignal(rsi),
    macd: macdSignal(macd),
    bollinger: bollingerSignal(latestPrice, bollinger),
    volumeSurge,
    sentiment: sentimentSignal(sentiment),
    ivRank,
  };

  const score = weightedComposite(indicatorSignals);
  const explanation = buildExplanation(indicatorSignals);
  const details = buildDetails({
    symbol,
    latestPrice,
    sma50,
    sma200,
    rsi,
    macd,
    bollinger,
    volumeSurge,
    sentiment,
    ivRank,
    fundamentals,
  });

  return {
    symbol,
    score,
    updatedAt: new Date().toISOString(),
    latestPrice,
    explanation,
    signals: indicatorSignals,
    details,
  };
}
