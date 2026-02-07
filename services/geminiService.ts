
import { GoogleGenAI, Type } from "@google/genai";
import { AreaAnalysis, Recommendation } from "../types";

const ai = new GoogleGenAI({ apiKey: process.env.API_KEY || '' });

// Fixed registry of official data sources to ensure consistency
const OFFICIAL_REGISTRY = [
  "https://www.singstat.gov.sg/find-data/search-by-theme/population/geographic-distribution/latest-data",
  "https://www.singstat.gov.sg/publications/population/census-of-population-2020",
  "https://www.hdb.gov.sg/residential/buying-a-flat/finding-a-flat/hdb-towns-and-estates",
  "https://www.ura.gov.sg/property-market-information/pmiResidentialRentalSearch"
];

const RECOMMENDATION_SCHEMA = {
  type: Type.OBJECT,
  properties: { 
    businessType: { type: Type.STRING }, 
    category: { type: Type.STRING, enum: ['F&B', 'Retail', 'Wellness', 'Education', 'Services', 'Other'] },
    opportunityScore: { type: Type.NUMBER }, 
    thesis: { type: Type.STRING }, 
    gapReason: { type: Type.STRING }, 
    estimatedRental: { type: Type.NUMBER }, 
    suggestedLocations: { type: Type.ARRAY, items: { type: Type.STRING } },
    dataSourceTitle: { type: Type.STRING, description: "Title of a real web source used for benchmarking" },
    dataSourceUrl: { type: Type.STRING, description: "URL of a real web source used for benchmarking" },
    businessProfile: {
      type: Type.OBJECT,
      properties: {
        size: { type: Type.STRING },
        targetAudience: { type: Type.STRING },
        strategy: { type: Type.STRING },
        employees: { type: Type.STRING }
      },
      required: ["size", "targetAudience", "strategy", "employees"]
    },
    financials: {
      type: Type.OBJECT,
      properties: {
        upfrontCost: { type: Type.NUMBER, description: "Total upfront investment in SGD" },
        monthlyCost: { type: Type.NUMBER, description: "Monthly operating costs in SGD" },
        monthlyRevenueBad: { type: Type.NUMBER, description: "Conservative monthly revenue estimate in SGD" },
        monthlyRevenueAvg: { type: Type.NUMBER, description: "Average monthly revenue estimate in SGD" },
        monthlyRevenueGood: { type: Type.NUMBER, description: "Optimistic monthly revenue estimate in SGD" }
      },
      required: ["upfrontCost", "monthlyCost", "monthlyRevenueBad", "monthlyRevenueAvg", "monthlyRevenueGood"]
    }
  },
  required: ["businessType", "category", "opportunityScore", "thesis", "businessProfile", "financials"]
};

export const analyzeTown = async (town: string, previousAnalysis?: AreaAnalysis): Promise<AreaAnalysis> => {
  const currentDate = new Date().toISOString().split('T')[0];
  const isIncrementalUpdate = !!previousAnalysis;

  const prompt = `
    Perform a "High-Resolution Commercial Opportunity Scan" for the HDB town of "${town}", Singapore as of today (${currentDate}). 
    
    DATA SOURCE PROTOCOL (STRICT):
    For Section 1 (Demographics & Wealth), you are RESTRICTED to using data consistent with the following Official Registries:
    ${OFFICIAL_REGISTRY.map(url => `- ${url}`).join('\n')}
    
    CRITICAL INTELLIGENCE REQUIREMENTS:
    
    1. DEMOGRAPHICS & WEALTH (CONSISTENCY MANDATORY): 
       - Extract data specifically for the "${town}" Planning Area from SingStat Census 2020/2021 standards.
       - Median Monthly Household Income: Return strictly the numeric/currency value (e.g. "SGD 8,500" or "SGD 7,000 - 9,000"). Do NOT include citations or text like "(Census 2020)" in this field.
       - Median Household Income Per Capita: Return strictly the numeric/currency value.
       - Detailed Age Breakdown: percentages for 0-14, 15-24, 25-64, 65+.
       - Race Breakdown: percentages for Chinese, Malay, Indian, Others.
       - Employment Status: percentages for Working, Student, Unemployed/Retired.
       - Private Housing vs HDB Mix percentage.
       - **PROVIDE EXACT URL** of the specific SingStat table or URA page used in 'dataSourceUrl'.
    
    2. AREA SATURATION ANALYSIS: Identify the density of existing businesses within specific precincts.

    3. HDB TENDERS & RENTALS:
       - List valid HDB commercial tenders for "${town}".
       - STATUS FIELD IS CRITICAL: You must determine if a tender is 'OPEN', 'CLOSED', or 'AWARDED' based on the Closing Date vs Today (${currentDate}).
       - If Closing Date > Today, Status = 'OPEN'.
       - If Closing Date < Today, Status = 'CLOSED' (or 'AWARDED' if explicitly stated).
       - Do not return 'NA' for status. Calculate it.

    4. RECOMMENDATIONS: You MUST provide EXACTLY 3 high-conviction business recommendations. 
       - Classify each into a Category: 'F&B', 'Retail', 'Wellness', 'Education', 'Services', or 'Other'.
       - Assign an opportunity score (0-100).
       - Provide a 'dataSourceUrl' for a relevant industry report or competitor pricing page that validates this idea.
       
       FOR EACH RECOMMENDATION, PROVIDE A DEEP DIVE:
       - Business Profile: Recommended size (sqft), target audience, strategy (volume vs niche), and employee count.
       - Financial Analysis (Estimates in SGD):
         * Upfront Investment (Renovation, Equipment, Licenses).
         * Monthly Operating Cost (Rent, Utilities, Wages, COGS).
         * Monthly Revenue Scenarios: Bad, Average, Good.
       These numbers will be used to generate a break-even graph, so ensure they are realistic for the Singapore context.

    ${isIncrementalUpdate ? `
    MARATHON LOOP CONTEXT:
    Previous Pulse: "${previousAnalysis.commercialPulse}"
    Track changes in property prices or new retail openings in the last quarter.
    ` : 'First-pass strategic audit of the planning area.'}

    Return result in JSON format.
  `;

  const response = await ai.models.generateContent({
    model: "gemini-3-pro-preview",
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          town: { type: Type.STRING },
          commercialPulse: { type: Type.STRING },
          demographicsFocus: { type: Type.STRING },
          wealthMetrics: {
            type: Type.OBJECT,
            properties: {
              medianHouseholdIncome: { type: Type.STRING },
              medianHouseholdIncomePerCapita: { type: Type.STRING },
              privatePropertyRatio: { type: Type.STRING },
              wealthTier: { type: Type.STRING, enum: ["Mass Market", "Upper Mid", "Affluent", "Silver Economy"] },
              sourceNote: { type: Type.STRING },
              dataSourceUrl: { type: Type.STRING }
            },
            required: ["medianHouseholdIncome", "medianHouseholdIncomePerCapita", "privatePropertyRatio", "wealthTier", "dataSourceUrl"]
          },
          demographicData: {
            type: Type.OBJECT,
            properties: {
              residentPopulation: { type: Type.STRING },
              planningArea: { type: Type.STRING },
              ageDistribution: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { label: { type: Type.STRING }, value: { type: Type.NUMBER } } } },
              raceDistribution: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { label: { type: Type.STRING }, value: { type: Type.NUMBER } } } },
              employmentStatus: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { label: { type: Type.STRING }, value: { type: Type.NUMBER } } } },
              dataSourceUrl: { type: Type.STRING }
            },
            required: ["residentPopulation", "ageDistribution", "raceDistribution", "employmentStatus"]
          },
          discoveryLogs: {
            type: Type.OBJECT,
            properties: {
              tenders: { type: Type.OBJECT, properties: { label: { type: Type.STRING }, logs: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { timestamp: { type: Type.STRING }, action: { type: Type.STRING }, result: { type: Type.STRING } } } } } },
              saturation: { type: Type.OBJECT, properties: { label: { type: Type.STRING }, logs: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { timestamp: { type: Type.STRING }, action: { type: Type.STRING }, result: { type: Type.STRING } } } } } },
              areaSaturation: { type: Type.OBJECT, properties: { label: { type: Type.STRING }, logs: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { timestamp: { type: Type.STRING }, action: { type: Type.STRING }, result: { type: Type.STRING } } } } } },
              traffic: { type: Type.OBJECT, properties: { label: { type: Type.STRING }, logs: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { timestamp: { type: Type.STRING }, action: { type: Type.STRING }, result: { type: Type.STRING } } } } } },
              rental: { type: Type.OBJECT, properties: { label: { type: Type.STRING }, logs: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { timestamp: { type: Type.STRING }, action: { type: Type.STRING }, result: { type: Type.STRING } } } } } }
            }
          },
          pulseTimeline: { type: Type.ARRAY, items: { type: Type.OBJECT, properties: { timestamp: { type: Type.STRING }, event: { type: Type.STRING }, impact: { type: Type.STRING, enum: ["positive", "negative", "neutral"] } } } },
          recommendations: { 
            type: Type.ARRAY, 
            items: RECOMMENDATION_SCHEMA 
          },
          activeTenders: { 
            type: Type.ARRAY, 
            items: { 
              type: Type.OBJECT, 
              properties: { 
                block: { type: Type.STRING }, 
                street: { type: Type.STRING }, 
                closingDate: { type: Type.STRING }, 
                status: { type: Type.STRING, enum: ['OPEN', 'CLOSED', 'AWARDED', 'PENDING'] }, 
                areaSqft: { type: Type.NUMBER } 
              },
              required: ["block", "street", "closingDate", "status", "areaSqft"]
            } 
          }
        },
        required: ["town", "commercialPulse", "demographicsFocus", "wealthMetrics", "demographicData", "discoveryLogs", "pulseTimeline", "recommendations", "activeTenders"]
      }
    }
  });

  const rawText = response.text || "{}";
  const newData = JSON.parse(rawText);
  
  const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const defaultSources = OFFICIAL_REGISTRY.slice(0, 2).map(uri => ({
    title: "Official SingStat Registry",
    uri: uri
  }));

  // Create unique source map by URI to prevent duplicates
  const uniqueSourcesMap = new Map();
  
  groundingChunks.forEach((chunk: any) => {
    if (chunk.web?.uri && chunk.web.uri !== "#") {
      uniqueSourcesMap.set(chunk.web.uri, {
        title: chunk.web.title || "SingStat / Official Source",
        uri: chunk.web.uri
      });
    }
  });

  let sources = Array.from(uniqueSourcesMap.values());

  if (sources.length === 0) {
    sources = defaultSources;
  }

  // Fallback for granular sources if AI misses them
  if (!newData.wealthMetrics.dataSourceUrl) newData.wealthMetrics.dataSourceUrl = sources[0]?.uri;
  if (!newData.demographicData.dataSourceUrl) newData.demographicData.dataSourceUrl = sources[0]?.uri;

  if (previousAnalysis) {
    const mergedLogs: Record<string, any> = {};
    const categories = ['tenders', 'saturation', 'areaSaturation', 'traffic', 'rental'];
    categories.forEach(cat => {
      const newLogs = newData.discoveryLogs[cat]?.logs || [];
      const prevLogs = previousAnalysis.discoveryLogs[cat as keyof typeof previousAnalysis.discoveryLogs]?.logs || [];
      mergedLogs[cat] = {
        label: newData.discoveryLogs[cat]?.label || previousAnalysis.discoveryLogs[cat as keyof typeof previousAnalysis.discoveryLogs]?.label,
        logs: [...newLogs, ...prevLogs].slice(0, 50)
      };
    });

    const mergedTimeline = [...newData.pulseTimeline, ...previousAnalysis.pulseTimeline]
      .filter((v, i, a) => a.findIndex(t => t.event === v.event) === i)
      .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
      .slice(0, 100);

    return {
      ...newData,
      discoveryLogs: mergedLogs,
      pulseTimeline: mergedTimeline,
      sources: [...sources, ...previousAnalysis.sources]
        .filter((v, i, a) => a.findIndex(t => t.uri === v.uri) === i) // Dedup against previous sources
        .slice(0, 20),
      monitoringStarted: previousAnalysis.monitoringStarted,
      lastScannedAt: new Date().toISOString()
    };
  }

  return {
    ...newData,
    sources,
    monitoringStarted: currentDate,
    lastScannedAt: new Date().toISOString()
  };
};

export const generateSpecificDossier = async (town: string, businessType: string, existingAnalysis: AreaAnalysis): Promise<Recommendation> => {
  const prompt = `
    Generate a SINGLE "Strategic Investment Dossier" for a "${businessType}" in the town of "${town}", Singapore.
    
    CONTEXT (Use this to ensure financial realism and demographic fit):
    - Town Wealth Tier: ${existingAnalysis.wealthMetrics.wealthTier}
    - Median Income: ${existingAnalysis.wealthMetrics.medianHouseholdIncome}
    - Population: ${existingAnalysis.demographicData.residentPopulation}
    
    REQUIREMENTS:
    - Create a realistic business plan for a "${businessType}".
    - Provide Financials in SGD.
    - Classify it correctly (e.g., F&B, Retail).
    - Provide a 'dataSourceUrl' for a relevant benchmark or competitor.
    
    Return ONLY the single Recommendation object in JSON.
  `;

  const response = await ai.models.generateContent({
    model: "gemini-3-pro-preview",
    contents: prompt,
    config: {
      tools: [{ googleSearch: {} }],
      responseMimeType: "application/json",
      responseSchema: RECOMMENDATION_SCHEMA
    }
  });

  return JSON.parse(response.text || "{}");
};
