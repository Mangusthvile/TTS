
import { GoogleGenAI, Type } from "@google/genai";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

export async function smartExtractChapter(rawContent: string) {
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `Extract the main chapter title and the primary narrative text content from the following input. 
               The input might be messy text copied from a website. 
               Ignore ads, navigation menus, social media links, and footer content.
               Return the output as a clean JSON object with "title" and "content" fields.
               
               Input Content:
               ${rawContent.substring(0, 15000)}`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "The extracted title of the chapter" },
          content: { type: Type.STRING, description: "The cleaned main narrative text" }
        },
        required: ["title", "content"]
      }
    }
  });

  try {
    return JSON.parse(response.text);
  } catch (e) {
    console.error("Failed to parse Gemini response:", response.text);
    throw new Error("Gemini failed to return valid JSON. The input might be too messy.");
  }
}
