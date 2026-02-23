import { complete, type Model } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

const skillPattern = /^\/skill:(\S+)\s*([\s\S]*)/;

const SUMMARY_PROMPT =
  "Summarize the user's request in 5-10 words max. Output ONLY the summary, nothing else. No quotes, no punctuation at the end.";

const PREFERRED_MODEL_BY_PROVIDER: Record<string, string> = {
  "openai-codex": "gpt-5.1-codex-mini",
  "google-gemini-cli": "gemini-2.5-flash",
};

async function tryProviderModel(
  ctx: ExtensionContext,
  provider: string,
  modelId: string,
): Promise<{ model: Model<any>; apiKey: string } | null> {
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model) {
    return null;
  }

  const apiKey = await ctx.modelRegistry.getApiKey(model);
  if (!apiKey) {
    return null;
  }

  return { model, apiKey };
}

async function pickCheapModel(ctx: ExtensionContext): Promise<{ model: Model<any>; apiKey: string } | null> {
  if (!ctx.model) {
    return null;
  }

  const provider = ctx.model.provider;
  const preferredModelId = PREFERRED_MODEL_BY_PROVIDER[provider];

  if (preferredModelId) {
    const preferred = await tryProviderModel(ctx, provider, preferredModelId);
    if (preferred) {
      return preferred;
    }
  }

  // Fallback: current model.
  const currentApiKey = await ctx.modelRegistry.getApiKey(ctx.model);
  if (currentApiKey) {
    return { model: ctx.model, apiKey: currentApiKey };
  }

  return null;
}

export default function (pi: ExtensionAPI) {
  let named = false;

  const syncNamedState = () => {
    named = !!pi.getSessionName();
  };

  pi.on("session_start", syncNamedState);
  pi.on("session_switch", syncNamedState);

  pi.on("input", (event, ctx) => {
    if (named) return;

    const rawText = event.text.trim();
    if (!rawText) return;

    let prefix = "";
    let userPrompt = rawText;

    const skillMatch = rawText.match(skillPattern);
    if (skillMatch) {
      const skillName = skillMatch[1];
      prefix = `[${skillName}] `;
      userPrompt = skillMatch[2].trim();

      if (!userPrompt) {
        named = true;
        pi.setSessionName(`[${skillName}]`);
        return;
      }
    } else if (rawText.startsWith("/")) {
      // Ignore slash commands (except /skill:... handled above)
      return;
    }

    named = true;

    // Set a temporary name immediately so something shows up
    pi.setSessionName(`${prefix}${userPrompt.slice(0, 60)}`.trim());

    // Fire-and-forget summarization so prompt handling is never blocked.
    void (async () => {
      const cheap = await pickCheapModel(ctx);
      if (!cheap) return;

      try {
        const response = await complete(
          cheap.model,
          {
            systemPrompt: SUMMARY_PROMPT,
            messages: [{ role: "user", content: [{ type: "text", text: userPrompt }], timestamp: Date.now() }],
          },
          { apiKey: cheap.apiKey },
        );

        const summary = response.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
          .join("")
          .trim();

        if (summary) {
          pi.setSessionName(`${prefix}${summary}`.trim());
        }
      } catch {
        // Keep the truncated name, no big deal
      }
    })();
  });
}
