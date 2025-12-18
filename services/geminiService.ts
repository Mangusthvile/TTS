import { GoogleGenAI, Type } from "@google/genai";

// Local ambient declaration to satisfy TypeScript compiler (TS2591) 
// for the required process.env.API_KEY pattern.
declare const process: any;

/**
 * Cleanly extracts chapter content using Gemini.
 */
export async function smartExtractChapter(rawContent: string) {
  // Use the required pattern process.env.API_KEY. 
  // This is replaced at build time by Vite as configured in vite.config.ts.
  const apiKey = process.env.API_KEY;

  if (!apiKey) {
    throw new Error("VITE_GEMINI_API_KEY is not configured in the environment. Please set this variable in your Netlify settings or local .env file.");
  }

  const ai = new GoogleGenAI({ apiKey });
  
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

  // Use the .text property directly to extract output from GenerateContentResponse
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