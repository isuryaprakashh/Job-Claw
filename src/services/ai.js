const { GoogleGenerativeAI } = require('@google/generative-ai');
const logger = require('../utils/logger');

// Initialize Gemini API client
const apiKey = process.env.GEMINI_API_KEY;
if (!apiKey) {
  logger.error('GEMINI_API_KEY is not defined in the environment variables.');
}
const genAI = new GoogleGenerativeAI(apiKey || 'dummy-key');

/**
 * Parses raw opportunity post content using Gemini AI, extracting a list of opportunity details.
 * @param {string} textContent The raw message content from Telegram.
 * @param {Array<object>} webpageContexts Scraped contents of the links in the message.
 * @returns {Promise<Array<object>>} A list of parsed opportunity metadata objects.
 */
async function extractJobDetails(textContent, webpageContexts = []) {
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
    const systemPrompt = `You are an opportunity extraction engine for student communities.
Your task is to analyze the user's message (and any provided webpage content) and extract all valid jobs, internships, hackathons, coding contests, case competitions, business competitions, challenges, ideathons, quizzes, and similar student opportunities present.
For each opportunity, extract:
- opportunityType (must be exactly one of: "job", "hackathon", "competition". Use "job" for jobs and internships, "hackathon" for hackathons/buildathons, and "competition" for coding contests, case competitions, quizzes, challenges, ideathons, or other competitive events)
- company (for jobs: company name. For hackathons/competitions: organizer, host, platform, or sponsor name)
- role (for jobs: job/internship title. For hackathons/competitions: event title)
- applyLink (the URL to apply/register for the opportunity. MUST be a valid HTTP/HTTPS link. Extract the most direct application/registration link available)
- deadline (date when applications/registrations close. If the raw text mentions a deadline, convert it to YYYY-MM-DD format. Assume the current year is ${currentYear} if not specified. If deadline is missing or ambiguous, set it to null)
- location (job/event location e.g. Bangalore, Remote, Online, etc. If missing, use empty string)
- salary (salary, stipend, or compensation details. If missing, use empty string)
- batchEligibility (graduating batch/year eligibility e.g. "2025/2026 Batch", "2026 graduates only". If missing, use empty string)
- prize (prize pool, rewards, certificates, goodies, or benefits for hackathons/competitions. If missing, use empty string)
- eventDate (date when the hackathon/competition/event happens, not the registration deadline. Convert to YYYY-MM-DD. If missing or ambiguous, set it to null)
- format (online/offline/hybrid/team size/duration details when available. If missing, use empty string)

Return a JSON array of objects containing these keys. If no valid opportunities are found, return an empty array []. Do not include any formatting, markdown markers, or chat text outside the JSON.`;

    let prompt = `Raw Opportunity Posting Content:
"""
${textContent}
"""`;

    if (webpageContexts && webpageContexts.length > 0) {
      prompt += `\n\nAdditionally, here is the scraped webpage content from the linked opportunity pages to help you extract accurate company, role, deadline, location, batch requirements, etc.:`;
      webpageContexts.forEach((ctx, index) => {
        prompt += `\n\n--- Link [${index + 1}] (${ctx.url}) ---\n${ctx.content}\n--- End Link [${index + 1}] ---`;
      });
    }

    // Define JSON schema for structured output to ensure consistency
    const jsonSchema = {
      type: "array",
      items: {
        type: "object",
        properties: {
          company: { type: "string" },
          role: { type: "string" },
          opportunityType: { type: "string", enum: ["job", "hackathon", "competition"] },
          applyLink: { type: "string" },
          deadline: { type: "string", nullable: true },
          location: { type: "string" },
          salary: { type: "string" },
          batchEligibility: { type: "string" },
          prize: { type: "string" },
          eventDate: { type: "string", nullable: true },
          format: { type: "string" }
        },
        required: ["company", "role", "applyLink", "opportunityType"]
      }
    };

    logger.info('Calling Gemini API (%s) for multiple opportunity details extraction...', modelName);
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

      // Clean up dates
      let deadlineDate = null;
      if (parsedData.deadline) {
        const parsedDate = new Date(parsedData.deadline);
        if (!isNaN(parsedDate.getTime())) {
          deadlineDate = parsedDate;
        }
      }

      let eventDate = null;
      if (parsedData.eventDate) {
        const parsedDate = new Date(parsedData.eventDate);
        if (!isNaN(parsedDate.getTime())) {
          eventDate = parsedDate;
        }
      }

      const opportunityType = ['job', 'hackathon', 'competition'].includes(parsedData.opportunityType)
        ? parsedData.opportunityType
        : 'job';

      normalizedJobs.push({
        opportunityType,
        company: parsedData.company,
        role: parsedData.role,
        applyLink: parsedData.applyLink,
        deadline: deadlineDate,
        location: parsedData.location || '',
        salary: parsedData.salary || '',
        batchEligibility: parsedData.batchEligibility || '',
        prize: parsedData.prize || '',
        eventDate,
        format: parsedData.format || ''
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
        opportunityType: 'job',
        company: 'Unknown Organizer',
        role: 'Opportunity',
        applyLink: url,
        deadline: null,
        location: '',
        salary: '',
        batchEligibility: '',
        prize: '',
        eventDate: null,
        format: ''
      }));
    }

    return [];
  }
}

module.exports = {
  extractJobDetails
};
