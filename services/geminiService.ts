import { GoogleGenAI, Type } from "@google/genai";

export interface ExtractedChapter {
  title: string;
  content: string;
  index: number;
}

const rawApiKey = import.meta.env.VITE_GEMINI_API_KEY;

export const GEMINI_ENABLED =
  typeof rawApiKey === "string" && rawApiKey.trim().length > 0;

let client: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI {
  if (client) return client;

  const key = import.meta.env.VITE_GEMINI_API_KEY;

  if (typeof key !== "string" || key.trim() === "") {
    throw new Error(
      "Missing VITE_GEMINI_API_KEY. Add it to a .env file (Vite env vars must start with VITE_)."
    );
  }

  client = new GoogleGenAI({ apiKey: key.trim() });
  return client;
}

export async function extractChapterWithAI(
  rawText: string
): Promise<ExtractedChapter> {
  const ai = getGeminiClient();

  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Extract the story content from the following raw text or HTML.
Identify the chapter title and the chapter number/index.
Ignore all navigation links, ads, footer text, and comments.
Return only the clean story prose.

RAW CONTENT:
${rawText.substring(0, 30000)}`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "The title of the chapter." },
          content: {
            type: Type.STRING,
            description: "The cleaned story text content.",
          },
          index: {
            type: Type.INTEGER,
            description: "The chapter number or index.",
          },
        },
        required: ["title", "content", "index"],
      },
    },
  });

  try {
    const raw = response.text ?? "";
    if (!raw.trim()) throw new Error("Gemini returned an empty response.");

    const data = JSON.parse(raw) as ExtractedChapter;

    if (!data?.title || !data?.content || typeof data.index !== "number") {
      throw new Error("Gemini response JSON missing required fields.");
    }

    return data;
  } catch {
    throw new Error("Failed to parse AI extraction results.");
  }
}
