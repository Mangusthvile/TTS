
import { GoogleGenAI, Type } from "@google/genai";

/**
 * Cleanly extracts chapter content using Gemini.
 */
export async function smartExtractChapter(rawContent: string) {
  // Use process.env.API_KEY exclusively for Gemini API as per mandatory guidelines.
  // The API key is assumed to be pre-configured and accessible in the environment.
  // Initialization must use a named parameter: { apiKey: process.env.API_KEY }.
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  // Directly use ai.models.generateContent with model name and prompt.
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

  // Extract the text property from GenerateContentResponse directly (do not use text() method).
  const text = response.text;
  if (!text) {
    throw new Error("No text returned from Gemini");
  }

  try {
    return JSON.parse(text);
  } catch (e) {
    console.error("Failed to parse Gemini response:", text);
    throw new Error("Gemini failed to return valid JSON. The model may have returned an unexpected format.");
  }
}
