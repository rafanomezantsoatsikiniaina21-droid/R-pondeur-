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
  // Le code envoyé (s'il existe) doit correspondre à un des codes valides
  // définis dans les variables d'environnement Vercel (UNLOCK_CODES, séparés par des virgules).
  const validCodes = (process.env.UNLOCK_CODES || '')
    .split(',')
    .map(c => c.trim())
    .filter(Boolean);

  const isUnlocked = code && validCodes.includes(code);

  if (!isUnlocked) {
    const ip = (req.headers['x-forwarded-for'] || req.socket?.remoteAddress || 'unknown')
      .toString()
      .split(',')[0]
      .trim();

    const { count } = await checkIpQuota(ip);

    // req.body.freeUsed : compteur côté navigateur (moins fiable, gardé en complément)
    const freeUsed = Number(req.body.freeUsed) || 0;

    if (count > FREE_LIMIT || freeUsed >= FREE_LIMIT) {
      return res.status(402).json({ error: 'QUOTA_DEPASSE' });
    }
  }

  const businessName = (business || "l'établissement").slice(0, 120);
  const toneWish = (tone || "chaleureux et professionnel").slice(0, 120);
  const reviewText = review.slice(0, 2000);

  const prompt = `Tu es le gérant de ${businessName}. Un client a laissé l'avis suivant en ligne :\n\n"${reviewText}"\n\nÉcris une réponse publique à cet avis, dans un ton ${toneWish}. Écris la réponse dans la même langue que l'avis ci-dessus (si l'avis est en anglais, réponds en anglais ; s'il est en français, réponds en français ; etc.). 3 à 5 phrases maximum, sans formule d'ouverture générique type "Cher client" ou "Dear customer". Ne mets pas de guillemets autour de la réponse, donne uniquement le texte de la réponse.`;

  try {
    const apiRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }],
      }),
    });

    if (!apiRes.ok) {
      const errText = await apiRes.text();
      console.error('Erreur API Anthropic:', errText);
      return res.status(502).json({ error: "Erreur du service de génération." });
    }

    const data = await apiRes.json();
    const textBlock = (data.content || []).find(b => b.type === 'text');
    const answer = textBlock ? textBlock.text : '';

    return res.status(200).json({ answer });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: "Erreur serveur." });
  }
}
