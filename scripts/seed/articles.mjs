// The seed corpus is a themed set: ~100 countries spanning every continent.
// A uniform, richly-structured topic (each article has an infobox, flag, maps,
// photos and history/economy/geography sections) makes the corpus fertile for
// non-trivial cross-document agentic tasks — ranking by population or area,
// grouping by continent, joining on shared currencies, building comparison
// tables, spotting landlocked nations, timelines of independence, and so on.
//
// Titles use Wikipedia's canonical form (disambiguated where needed, e.g.
// "Georgia (country)"). A handful beyond 100 absorb the odd fetch failure so
// the final corpus still lands at ~100 documents.
export const ARTICLES = [
  // Africa
  'Nigeria', 'Egypt', 'South Africa', 'Kenya', 'Ethiopia', 'Ghana', 'Morocco',
  'Algeria', 'Tanzania', 'Uganda', 'Senegal', 'Tunisia', 'Angola', 'Zimbabwe',
  'Botswana', 'Namibia', 'Rwanda', 'Democratic Republic of the Congo', 'Mozambique',
  'Madagascar',
  // Asia
  'China', 'Japan', 'India', 'Indonesia', 'Pakistan', 'Bangladesh', 'Vietnam',
  'Thailand', 'Philippines', 'South Korea', 'Malaysia', 'Singapore',
  'Saudi Arabia', 'Iran', 'Iraq', 'Israel', 'Turkey', 'Kazakhstan', 'Nepal',
  'Sri Lanka', 'Myanmar', 'Cambodia', 'Mongolia', 'United Arab Emirates',
  'Qatar', 'Jordan', 'Uzbekistan',
  // Europe
  'France', 'Germany', 'Italy', 'Spain', 'United Kingdom', 'Portugal',
  'Netherlands', 'Belgium', 'Switzerland', 'Austria', 'Sweden', 'Norway',
  'Denmark', 'Finland', 'Poland', 'Greece', 'Ireland', 'Iceland', 'Hungary',
  'Czech Republic', 'Romania', 'Ukraine', 'Russia', 'Croatia', 'Serbia',
  'Estonia', 'Georgia (country)',
  // Americas
  'United States', 'Canada', 'Mexico', 'Brazil', 'Argentina', 'Chile',
  'Colombia', 'Peru', 'Venezuela', 'Ecuador', 'Bolivia', 'Uruguay', 'Paraguay',
  'Cuba', 'Jamaica', 'Costa Rica', 'Panama', 'Guatemala', 'Dominican Republic',
  // Oceania
  'Australia', 'New Zealand', 'Fiji', 'Papua New Guinea', 'Samoa',
  // Buffer (extra countries to backfill any fetch failures)
  'Zambia', 'Cameroon', 'Ivory Coast', 'Libya', 'Mali', 'Kuwait', 'Oman',
  'Azerbaijan', 'Bulgaria', 'Slovakia', 'Lithuania', 'Slovenia', 'Honduras',
  'El Salvador', 'Nicaragua', 'Trinidad and Tobago',
];
