// supabase/functions/create-invoice/index.ts
// Создаёт ссылку на счёт Telegram Stars через Bot API createInvoiceLink.
// Секрет BOT_TOKEN задаётся через `supabase secrets set BOT_TOKEN=...`
// (или в Dashboard → Edge Functions → Secrets).

const BOT_TOKEN = Deno.env.get("BOT_TOKEN")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: CORS_HEADERS });
  }

  try {
    const { title, description, payload, amount_stars } = await req.json();
    if (!title || !payload || !amount_stars) {
      return new Response(JSON.stringify({ error: "missing fields" }), { status: 400, headers: CORS_HEADERS });
    }

    const tgRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/createInvoiceLink`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: String(title).slice(0, 32),
        description: String(description || title).slice(0, 255),
        payload: String(payload),
        currency: "XTR", // Telegram Stars
        prices: [{ label: String(title).slice(0, 32), amount: Number(amount_stars) }],
      }),
    });
    const tgData = await tgRes.json();

    if (!tgData.ok) {
      return new Response(JSON.stringify({ error: tgData.description || "telegram error" }), { status: 400, headers: CORS_HEADERS });
    }
    return new Response(JSON.stringify({ link: tgData.result }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
    });
  } catch (e) {
    return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: CORS_HEADERS });
  }
});
