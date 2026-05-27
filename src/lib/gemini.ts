import { GoogleGenAI, Type } from '@google/genai';

// Models to try in order — all are free-tier eligible.
// gemini-2.0-flash has limit:0 on free API keys, so we skip it.
const FREE_TIER_MODELS = [
  'gemini-1.5-flash',      // Most reliable free-tier model
  'gemini-1.5-flash-8b',   // Lighter fallback
  'gemini-2.0-flash-lite', // Newest free-tier lite variant
];

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    name:       { type: Type.STRING,  description: 'Patient full name',                                     nullable: true },
    phone:      { type: Type.STRING,  description: 'Patient phone number without +91 country code',         nullable: true },
    age:        { type: Type.NUMBER,  description: 'Patient age as a number',                               nullable: true },
    gender:     { type: Type.STRING,  description: 'Patient gender: male, female, or other',                nullable: true },
    billAmount: { type: Type.NUMBER,  description: 'Total bill amount as a number (no currency symbols)',    nullable: true },
    billDate:   { type: Type.STRING,  description: 'Bill date in YYYY-MM-DD format',                        nullable: true },
    medicines: {
      type: Type.ARRAY,
      description: 'List of medicine names only — no dosage, frequency, or duration',
      items: { type: Type.STRING },
      nullable: true,
    },
    doctor:    { type: Type.STRING, description: 'Doctor name',           nullable: true },
    diagnosis: { type: Type.STRING, description: 'Diagnosis or condition', nullable: true },
  },
};

const PROMPT = `
  You are a medical billing data extractor.
  Analyze the provided document (a bill or prescription image) and extract the specified fields.
  If a value for a specific field cannot be found or is not applicable, use null for that field.

  INSTRUCTIONS FOR MEDICINES:
  - Include ONLY the medicine names (e.g. "Crocin 500mg").
  - DO NOT include doses, frequency, or duration (remove "daily", "twice", "1-0-1", etc.).
  - If it's a bill, extract medicines purchased. If it's a prescription, extract prescribed medicines.

  INSTRUCTIONS FOR BILL AMOUNT:
  - Look for total amount, grand total, or net amount.
  - Return as a plain number only.
`;

/**
 * Extracts data from a bill or prescription image using Gemini.
 * Automatically tries multiple free-tier models in sequence.
 */
export async function extractBillData(
  apiKey: string,
  fileBlob: Blob,
  mimeType: string
): Promise<{
  name?: string;
  phone?: string;
  age?: number;
  gender?: 'male' | 'female' | 'other';
  billAmount?: number;
  billDate?: string;
  medicines?: string[];
  doctor?: string;
  diagnosis?: string;
}> {
  if (!apiKey) {
    throw new Error('Gemini API key is missing. Please configure it in Settings.');
  }

  // Convert Blob to base64
  const base64Data = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = reader.result as string;
      const parts = result.split(',');
      resolve(parts[1] ?? '');
    };
    reader.onerror = reject;
    reader.readAsDataURL(fileBlob);
  });

  const ai = new GoogleGenAI({ apiKey });

  for (const model of FREE_TIER_MODELS) {
    try {
      console.log(`[Gemini] Trying model: ${model}`);

      const response = await ai.models.generateContent({
        model,
        contents: {
          parts: [
            { text: PROMPT },
            { inlineData: { data: base64Data, mimeType } },
          ],
        },
        config: {
          responseMimeType: 'application/json',
          responseSchema: RESPONSE_SCHEMA,
        },
      });

      const text = response.text;
      if (!text) {
        throw new Error('AI returned an empty response.');
      }

      const parsed = JSON.parse(text);
      console.log(`[Gemini] Success with model: ${model}`);
      return parsed;

    } catch (err: unknown) {
      const error = err as { message?: string; status?: number };
      const msg = error?.message ?? String(err);

      // 429 quota / rate-limit → try next model
      if (msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED') || msg.includes('quota')) {
        console.warn(`[Gemini] Model ${model} quota exceeded, trying next...`);
        continue;
      }

      // 404 model not found → try next
      if (msg.includes('404') || msg.includes('not found')) {
        console.warn(`[Gemini] Model ${model} not available, trying next...`);
        continue;
      }

      // Any other error is likely auth / bad request — don't retry
      throw new Error(msg || 'An unexpected error occurred with the AI.');
    }
  }

  // All models exhausted
  throw new Error(
    'All free Gemini models are currently over quota. ' +
    'Please wait a minute and try again, or upgrade your Google AI plan at https://ai.dev/rate-limit'
  );
}
