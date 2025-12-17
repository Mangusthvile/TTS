
import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export async function extractChapterContent(url: string, rawHtml?: string) {
  const prompt = `
    INSTRUCTION:
    You are a strict deterministic extraction agent. 
    You must never write, summarize, or paraphrase chapter content.
    Your task is to extract the FULL, UNMODIFIED text content of a story chapter from the provided web content.

    MINIMAL EXTRACTION LOGIC:
    1. TITLE: Extract from the main chapter heading. Look for 'h2 a.chr-title' (check the 'title' attribute) or 'h1'.
    2. BODY: Extract from the main chapter container (e.g., 'div#chr-content').
    3. NEXT URL: Find the link to the next chapter (e.g., 'a#next_chap').

    GUARDRAILS:
    - If the extracted text word count is less than 800, return { "error": "EXTRACTION_FAILED" }.
    - If the extracted title does not include the chapter number found in the URL (${url}), return { "error": "EXTRACTION_FAILED" }.
    - Do not generate replacement text. 

    URL for context: ${url}
    ${rawHtml ? `RAW HTML CONTENT: \n${rawHtml.substring(0, 100000)}` : "Fetch and extract based on URL context."}

    RETURN JSON ONLY matching this schema:
  `;

  try {
    const response = await ai.models.generateContent({
      model: "gemini-3-flash-preview",
      contents: prompt,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            title: { type: Type.STRING },
            content: { type: Type.STRING },
            nextChapterUrl: { type: Type.STRING },
            error: { type: Type.STRING, description: "Set to EXTRACTION_FAILED if guardrails fail" }
          },
          required: ["title", "content"]
        }
      }
    });

    const data = JSON.parse(response.text);

    if (data.error === "EXTRACTION_FAILED") {
      throw new Error("EXTRACTION_FAILED: Content too short or title mismatch.");
    }

    // Secondary local guardrail check
    const wordCount = data.content.split(/\s+/).filter(Boolean).length;
    if (wordCount < 800) {
       throw new Error(`EXTRACTION_FAILED: Extracted content too short (${wordCount} words).`);
    }

    // Check title/URL consistency
    const urlMatch = url.match(/chapter-(\d+)/i);
    if (urlMatch) {
      const chapterNum = urlMatch[1];
      if (!data.title.includes(chapterNum)) {
        throw new Error(`EXTRACTION_FAILED: Title does not contain expected chapter number (${chapterNum}).`);
      }
    }

    return data;
  } catch (error) {
    console.error("Extraction Error:", error);
    throw error;
  }
}
