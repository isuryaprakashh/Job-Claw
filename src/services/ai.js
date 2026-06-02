const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../utils/logger');

// Initialize Gemini API client
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  logger.error('GEMINI_API_KEY is not defined in the environment variables.');
}
const genAI = new GoogleGenerativeAI(apiKey || 'dummy-key');

/**
 * Parses raw job post content using Gemini AI, extracting a list of job details.
 * @param {string} textContent The raw message content from Telegram.
 * @returns {Promise<Array<object>>} A list of parsed job metadata objects.
 */
async function extractJobDetails(textContent) {
  try {
    let modelName = 'gemini-2.5-flash';
    let model;
    try {
      model = genAI.getGenerativeModel({ model: modelName });
    } catch (err) {
      logger.warn(`Model ${modelName} not found, falling back to gemini-1.5-flash`);
      modelName = 'gemini-1.5-flash';
      model = genAI.getGenerativeModel({ model: modelName });
    }

    const currentYear = new Date().getFullYear();
    const systemPrompt = `You are a job opportunity extraction engine.
Your task is to analyze the user's message and extract all valid job opportunities present. 
For each opportunity, extract:
- company (name of the company offering the job/internship)
- role (title of the job or internship role)
- applyLink (the URL to apply for the job. MUST be a valid HTTP/HTTPS link. Extract the most direct application link available for this specific job)
- deadline (date when applications close. If the raw text mentions a deadline, convert it to YYYY-MM-DD format. Assume the current year is ${currentYear} if not specified. If deadline is missing or ambiguous, set it to null)
- location (job location e.g. Bangalore, Remote, etc. If missing, use empty string)
- salary (salary, stipend, or compensation details. If missing, use empty string)
- batchEligibility (graduating batch/year eligibility e.g. "2025/2026 Batch", "2026 graduates only". If missing, use empty string)

Return a JSON array of objects containing these keys. If no job opportunities are found, return an empty array []. Do not include any formatting, markdown markers, or chat text outside the JSON.`;

    const prompt = `Raw Job Posting Content:
"""
${textContent}
"""`;

    // Define JSON schema for structured output to ensure consistency
    const jsonSchema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          company: { type: "string" },
          role: { type: "string" },
          applyLink: { type: "string" },
          deadline: { type: "string", nullable: true },
          location: { type: "string" },
          salary: { type: "string" },
          batchEligibility: { type: "string" }
        },
        required: ["company", "role", "applyLink"]
      }
    };

    logger.info('Calling Gemini API (%s) for multiple job details extraction...', modelName);
    const result = await model.generateContent({
      contents: [
        { role: 'user', parts: [{ text: systemPrompt + '\n\n' + prompt }] }
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: jsonSchema
      }
    });

    const responseText = result.response.text().trim();
    logger.debug('Raw response from Gemini: %s', responseText);

    const parsedArray = JSON.parse(responseText);
    if (!Array.isArray(parsedArray)) {
      logger.warn('Gemini response is not an array: %s', responseText);
      return [];
    }

    const normalizedJobs = [];
    for (const parsedData of parsedArray) {
      if (!parsedData.company || !parsedData.role || !parsedData.applyLink) {
        logger.warn('Opportunity missing required fields, skipping: %o', parsedData);
        continue;
      }

      // Clean up deadline
      let deadlineDate = null;
      if (parsedData.deadline) {
        const parsedDate = new Date(parsedData.deadline);
        if (!isNaN(parsedDate.getTime())) {
          deadlineDate = parsedDate;
        }
      }

      normalizedJobs.push({
        company: parsedData.company,
        role: parsedData.role,
        applyLink: parsedData.applyLink,
        deadline: deadlineDate,
        location: parsedData.location || '',
        salary: parsedData.salary || '',
        batchEligibility: parsedData.batchEligibility || ''
      });
    }

    return normalizedJobs;

  } catch (error) {
    logger.error('Error during job details extraction with Gemini: %s', error.stack || error.message);
    
    // Fallback: If AI fails but there is a link in the message, we do a naive regex extraction
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const urls = textContent.match(urlRegex);
    if (urls && urls.length > 0) {
      logger.info('Using regex fallback extraction as Gemini failed...');
      // Extract unique urls
      const uniqueUrls = [...new Set(urls)];
      return uniqueUrls.map(url => ({
        company: 'Unknown Company',
        role: 'Job Opportunity',
        applyLink: url,
        deadline: null,
        location: '',
        salary: '',
        batchEligibility: ''
      }));
    }

    return [];
  }
}

module.exports = {
  extractJobDetails
};
