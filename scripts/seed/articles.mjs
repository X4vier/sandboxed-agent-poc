// The seed corpus is a themed set: ~100 countries spanning every continent.
// A uniform, richly-structured topic (each article has an infobox, flag, maps,
// photos and history/economy/geography sections) makes the corpus fertile for
// non-trivial cross-document agentic tasks — ranking by population or area,
// grouping by continent, joining on shared currencies, building comparison
// tables, spotting landlocked nations, timelines of independence, and so on.
//
// Titles use Wikipedia's canonical form (disambiguated where needed, e.g.
// "Georgia (country)"). The list covers essentially every UN member state so
// the corpus lands at ~190 documents; a handful of small nations absorb the
// odd fetch failure. The long tail of small/obscure countries is deliberate:
// their figures aren't the kind of thing a model recalls from memory, so
// answering questions about them forces the agent to actually read the files.
export const ARTICLES = [
  // Africa
  'Nigeria', 'Egypt', 'South Africa', 'Kenya', 'Ethiopia', 'Ghana', 'Morocco',
  'Algeria', 'Tanzania', 'Uganda', 'Senegal', 'Tunisia', 'Angola', 'Zimbabwe',
  'Botswana', 'Namibia', 'Rwanda', 'Democratic Republic of the Congo', 'Mozambique',
  'Madagascar', 'Zambia', 'Cameroon', 'Ivory Coast', 'Libya', 'Mali',
  'Sudan', 'South Sudan', 'Chad', 'Niger', 'Burkina Faso', 'Guinea', 'Benin',
  'Burundi', 'Somalia', 'Malawi', 'Togo', 'Sierra Leone', 'Liberia',
  'Central African Republic', 'Republic of the Congo', 'Mauritania', 'Eritrea',
  'The Gambia', 'Gabon', 'Lesotho', 'Guinea-Bissau', 'Equatorial Guinea',
  'Mauritius', 'Eswatini', 'Djibouti', 'Comoros', 'Cape Verde',
  'São Tomé and Príncipe', 'Seychelles',
  // Asia
  'China', 'Japan', 'India', 'Indonesia', 'Pakistan', 'Bangladesh', 'Vietnam',
  'Thailand', 'Philippines', 'South Korea', 'Malaysia', 'Singapore',
  'Saudi Arabia', 'Iran', 'Iraq', 'Israel', 'Turkey', 'Kazakhstan', 'Nepal',
  'Sri Lanka', 'Myanmar', 'Cambodia', 'Mongolia', 'United Arab Emirates',
  'Qatar', 'Jordan', 'Uzbekistan', 'Kuwait', 'Oman', 'Azerbaijan',
  'Yemen', 'Syria', 'Lebanon', 'Afghanistan', 'Turkmenistan', 'Kyrgyzstan',
  'Tajikistan', 'Armenia', 'Bahrain', 'Laos', 'North Korea', 'Bhutan',
  'Maldives', 'Brunei', 'East Timor',
  // Europe
  'France', 'Germany', 'Italy', 'Spain', 'United Kingdom', 'Portugal',
  'Netherlands', 'Belgium', 'Switzerland', 'Austria', 'Sweden', 'Norway',
  'Denmark', 'Finland', 'Poland', 'Greece', 'Ireland', 'Iceland', 'Hungary',
  'Czech Republic', 'Romania', 'Ukraine', 'Russia', 'Croatia', 'Serbia',
  'Estonia', 'Georgia (country)', 'Bulgaria', 'Slovakia', 'Lithuania',
  'Slovenia', 'Belarus', 'Moldova', 'Latvia', 'Bosnia and Herzegovina',
  'Albania', 'North Macedonia', 'Montenegro', 'Kosovo', 'Cyprus', 'Luxembourg',
  'Malta', 'Andorra', 'Monaco', 'Liechtenstein', 'San Marino', 'Vatican City',
  // Americas
  'United States', 'Canada', 'Mexico', 'Brazil', 'Argentina', 'Chile',
  'Colombia', 'Peru', 'Venezuela', 'Ecuador', 'Bolivia', 'Uruguay', 'Paraguay',
  'Cuba', 'Jamaica', 'Costa Rica', 'Panama', 'Guatemala', 'Dominican Republic',
  'Honduras', 'El Salvador', 'Nicaragua', 'Trinidad and Tobago', 'Haiti',
  'Belize', 'Guyana', 'Suriname', 'The Bahamas', 'Barbados', 'Saint Lucia',
  'Grenada', 'Antigua and Barbuda', 'Saint Vincent and the Grenadines',
  'Dominica', 'Saint Kitts and Nevis',
  // Oceania
  'Australia', 'New Zealand', 'Fiji', 'Papua New Guinea', 'Samoa',
  'Solomon Islands', 'Vanuatu', 'Kiribati', 'Tonga',
  'Federated States of Micronesia', 'Palau', 'Marshall Islands', 'Nauru',
  'Tuvalu',
];
