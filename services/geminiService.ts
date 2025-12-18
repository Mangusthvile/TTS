import { GoogleGenAI, Type } from "@google/genai";

export interface ExtractedChapter {
  title: string;
  content: string;
  index: number;
}

export async function extractChapterWithAI(rawText: string): Promise<ExtractedChapter> {
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY! });
  
  const response = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Extract the story content from the following raw text or HTML. 
    Identify the chapter title and the chapter number/index. 
    Ignore all navigation links, ads, footer text, and comments. 
    Return only the clean story prose.
    
    RAW CONTENT:
    ${rawText.substring(0, 30000)}`, // Limit input to avoid token overflow
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: {
            type: Type.STRING,
            description: "The title of the chapter.",
          },
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
    const data = JSON.parse(response.text);
    return data as ExtractedChapter;
  } catch (e) {
    throw new Error("Failed to parse AI extraction results.");
  }
}
