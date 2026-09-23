// Fonction serveur (Vercel). La clé API reste secrète ici, jamais exposée au navigateur.

const FREE_LIMIT = 3;
const WINDOW_SECONDS = 60 * 60 * 24 * 30; // 30 jours

// Vérifie/incrémente le compteur d'essais gratuits pour une adresse IP,
// via Upstash Redis (base de données gratuite, séparée du navigateur du visiteur —
// donc vider son navigateur ou passer en mode privé ne suffit plus à contourner la limite).
async function checkIpQuota(ip) {
  const url = process.env.UPSTASH_REDIS_REST_URL;
  const token = process.env.UPSTASH_REDIS_REST_TOKEN;

  // Si Upstash n'est pas configuré, on ne bloque pas (le compteur navigateur reste actif).
  if (!url || !token) return { count: 0, configured: false };

  const key = `repondeur:ip:${ip}`;
  const headers = { Authorization: `Bearer ${token}` };

  const incrRes = await fetch(`${url}/incr/${encodeURIComponent(key)}`, { headers });
  const incrData = await incrRes.json();
  const count = Number(incrData.result) || 1;

  if (count === 1) {
    // première requête de cette IP : on pose l'expiration (fenêtre glissante de 30 jours)
    await fetch(`${url}/expire/${encodeURIComponent(key)}/${WINDOW_SECONDS}`, { headers });
  }

  return { count, configured: true };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Méthode non autorisée' });
  }

  const { review, business, tone, code } = req.body || {};

  if (!review || typeof review !== 'string' || review.trim().length === 0) {
    return res.status(400).json({ error: "Avis manquant." });
  }

  // --- Vérification du quota gratuit / code de déblocage ---
  const validCodes = (process.env.UNLOCK_CODES || '')
    .split(',')
    .map(c => c.trim())
    .filter(Boolean);

  const isUnlocked = code && validCodes.includes(code);

  if (!isUnlocked) {
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress;
    const quota = await checkIpQuota(ip);

    if (quota.configured && quota.count > FREE_LIMIT) {
      return res.status(403).json({ error: 'quota_depasse' });
    }
  }

  // --- Appel à l'API Gemini (Google) ---
  const apiKey = process.env.GEMINI_API_KEY;

  if (!apiKey) {
    return res.status(500).json({ error: "Clé API Gemini manquante." });
  }

  const prompt = `Tu es un assistant qui aide un commerçant/restaurateur à répondre aux avis clients.
Nom de l'établissement : ${business || "l'établissement"}
Ton souhaité : ${tone || "professionnel et chaleureux"}
Avis du client à traiter :
"""
${review}
"""
Rédige une réponse courte (3 à 5 phrases), en français, personnalisée, qui remercie ou répond avec empathie selon le cas, sans être robotique. Ne mets pas de guillemets autour de la réponse.`;

  try {
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }]
        })
      }
    );

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      console.error('Erreur Gemini:', data);
      return res.status(500).json({ error: "Erreur lors de la génération." });
    }

    const reply = data.candidates?.[0]?.content?.parts?.[0]?.text;

    if (!reply) {
      return res.status(500).json({ error: "Réponse vide de l'IA." });
    }

    return res.status(200).json({ reply: reply.trim() });
  } catch (err) {
    console.error('Erreur serveur:', err);
    return res.status(500).json({ error: "Erreur serveur." });
  }
}
