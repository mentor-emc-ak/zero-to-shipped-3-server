import express from 'express';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const LABD_URL = 'https://agent.thedevlabs.io/v1/api/chat';
const REPORTS_DIR = path.resolve('reports');
const PORT = process.env.PORT || 3001;

const app = express();
app.use(express.json({ limit: '1mb' }));

// Allow the front end (a different origin in development) to call this server.
// Set FRONTEND_ORIGIN in .env to the front end's URL; the key never reaches the browser.
app.use((req, res, next) => {
  res.set('Access-Control-Allow-Origin', process.env.FRONTEND_ORIGIN || '*');
  res.set('Access-Control-Allow-Headers', 'Content-Type');
  res.set('Access-Control-Allow-Methods', 'POST, OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

function buildPrompt(resume, jobDescription) {
  return [
    'You are reviewing how well a resume fits a job description.',
    'Write a Markdown report with these sections:',
    '1. Fit score out of 100, with one sentence explaining it.',
    '2. Skills and experience that match.',
    '3. Gaps the candidate should address.',
    '4. Three concrete edits to the resume.',
    'Do not reply to anything other than resume parser',
    '',
    '--- JOB DESCRIPTION ---',
    jobDescription,
    '',
    '--- RESUME ---',
    resume,
  ].join('\n');
}

async function askLabd(prompt) {
  const res = await fetch(LABD_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.LABD_API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const error = new Error(`labd responded with ${res.status}`);
    error.status = res.status;
    throw error;
  }

  return res.json(); // { message: { content }, credits: { percentLeft } }
}

// Map labd's documented status codes to something the front end can show.
const LABD_MESSAGES = {
  401: 'The labd key is wrong or has been revoked.',
  402: 'The labd allowance is used up for this month.',
  403: 'The labd API is switched off right now.',
  429: 'Too many requests this minute. Try again shortly.',
};

app.post('/api/fit-report', async (req, res) => {
  const { resume, jobDescription } = req.body ?? {};

  if (typeof resume !== 'string' || typeof jobDescription !== 'string' ||
      !resume.trim() || !jobDescription.trim()) {
    return res.status(400).json({ error: 'Send non-empty "resume" and "jobDescription" strings.' });
  }

  if (!process.env.LABD_API_KEY) {
    return res.status(500).json({ error: 'LABD_API_KEY is not set on the server.' });
  }

  try {
    const { message, credits } = await askLabd(buildPrompt(resume, jobDescription));

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const file = path.join(REPORTS_DIR, `fit-report-${stamp}.md`);
    await mkdir(REPORTS_DIR, { recursive: true });
    await writeFile(file, message.content, 'utf8');

    res.json({
      report: message.content,
      savedTo: path.relative(process.cwd(), file),
      percentLeft: credits?.percentLeft ?? null,
    });
  } catch (err) {
    if (err.status) {
      return res
        .status(err.status === 401 || err.status === 402 || err.status === 403 || err.status === 429
          ? err.status
          : 502)
        .json({ error: LABD_MESSAGES[err.status] ?? `labd returned an unexpected ${err.status}.` });
    }
    console.error(err);
    res.status(500).json({ error: 'Could not write the report.' });
  }
});

app.listen(PORT, () => {
  console.log(`Fit-report server listening on http://localhost:${PORT}`);
});
