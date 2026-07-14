import { useMemo, useState } from 'react'
import { ComposableMap, Geographies, Geography, ZoomableGroup } from 'react-simple-maps'
import { X } from 'lucide-react'
import type { UserRecord } from '../types'

// Natural Earth 110m TopoJSON — tiny, no server required
const GEO_URL = 'https://cdn.jsdelivr.net/npm/world-atlas@2/countries-110m.json'

// Mapping of location strings (lowercase) → ISO 3166-1 numeric country code.
// Covers all UN member states, common territories, and major unambiguous capital cities.
const COUNTRY_NAME_TO_NUM: Record<string, number> = {
  // North America
  'united states': 840, 'usa': 840, 'u.s.': 840, 'united states of america': 840,
  'canada': 124,
  'mexico': 484,
  'puerto rico': 630,
  // Central America & Caribbean
  'belize': 84,
  'guatemala': 320,
  'honduras': 340,
  'el salvador': 222,
  'nicaragua': 558,
  'costa rica': 188,
  'panama': 591,
  'cuba': 192,
  'haiti': 332,
  'dominican republic': 214,
  'jamaica': 388,
  'trinidad and tobago': 780, 'trinidad': 780,
  'barbados': 52,
  'bahamas': 44,
  'grenada': 308,
  'antigua and barbuda': 28, 'antigua': 28,
  'saint kitts and nevis': 659,
  'saint lucia': 662,
  'saint vincent and the grenadines': 670,
  // South America
  'brazil': 76,
  'argentina': 32,
  'chile': 152,
  'colombia': 170,
  'peru': 604,
  'venezuela': 862,
  'ecuador': 218,
  'bolivia': 68,
  'uruguay': 858,
  'paraguay': 600,
  'guyana': 328,
  'suriname': 740,
  // Western Europe
  'united kingdom': 826, 'uk': 826, 'england': 826, 'great britain': 826, 'britain': 826,
  'scotland': 826, 'wales': 826,
  'germany': 276, 'deutschland': 276,
  'france': 250,
  'netherlands': 528, 'holland': 528,
  'sweden': 752,
  'switzerland': 756,
  'spain': 724,
  'italy': 380,
  'norway': 578,
  'denmark': 208,
  'finland': 246,
  'austria': 40,
  'belgium': 56,
  'portugal': 620,
  'ireland': 372,
  'iceland': 352,
  'luxembourg': 442,
  'andorra': 20,
  'monaco': 492,
  'liechtenstein': 438,
  'san marino': 674,
  'malta': 470,
  'cyprus': 196,
  // Eastern Europe
  'russia': 643,
  'poland': 616,
  'ukraine': 804,
  'czech republic': 203, 'czechia': 203,
  'romania': 642,
  'hungary': 348,
  'greece': 300,
  'slovakia': 703,
  'bulgaria': 100,
  'croatia': 191,
  'serbia': 688,
  'estonia': 233,
  'latvia': 428,
  'lithuania': 440,
  'slovenia': 705,
  'albania': 8,
  'north macedonia': 807, 'macedonia': 807,
  'bosnia and herzegovina': 70, 'bosnia': 70,
  'montenegro': 499,
  'kosovo': 383,
  'moldova': 498,
  'belarus': 112,
  // Caucasus
  'armenia': 51,
  'azerbaijan': 31,
  'georgia': 268,
  // Central Asia
  'kazakhstan': 398,
  'uzbekistan': 860,
  'kyrgyzstan': 417,
  'tajikistan': 762,
  'turkmenistan': 795,
  'afghanistan': 4,
  // Middle East
  'israel': 376,
  'turkey': 792, 'turkiye': 792,
  'iran': 364,
  'iraq': 368,
  'saudi arabia': 682,
  'uae': 784, 'united arab emirates': 784,
  'qatar': 634,
  'jordan': 400,
  'kuwait': 414,
  'oman': 512,
  'bahrain': 48,
  'lebanon': 422,
  'syria': 760,
  'yemen': 887,
  'palestine': 275,
  // South Asia
  'india': 356,
  'pakistan': 586,
  'bangladesh': 50,
  'sri lanka': 144,
  'nepal': 524,
  'bhutan': 64,
  'maldives': 462,
  // East & Southeast Asia
  'china': 156,
  'japan': 392,
  'south korea': 410, 'korea': 410,
  'north korea': 408,
  'taiwan': 158,
  'hong kong': 344,
  'singapore': 702,
  'thailand': 764,
  'vietnam': 704,
  'indonesia': 360,
  'malaysia': 458,
  'philippines': 608,
  'myanmar': 104, 'burma': 104,
  'cambodia': 116,
  'laos': 418,
  'brunei': 96,
  'mongolia': 496,
  'timor-leste': 626, 'east timor': 626,
  // Oceania
  'australia': 36,
  'new zealand': 554,
  'papua new guinea': 598,
  'fiji': 242,
  'solomon islands': 90,
  'vanuatu': 548,
  'samoa': 882,
  'tonga': 776,
  'kiribati': 296,
  'micronesia': 583,
  'marshall islands': 584,
  'palau': 585,
  'nauru': 520,
  'tuvalu': 798,
  // East Africa
  'kenya': 404,
  'ethiopia': 231,
  'tanzania': 834,
  'uganda': 800,
  'rwanda': 646,
  'burundi': 108,
  'somalia': 706,
  'djibouti': 262,
  'eritrea': 232,
  'south sudan': 728,
  'sudan': 729,
  'madagascar': 450,
  'mauritius': 480,
  'seychelles': 690,
  'comoros': 174,
  // Southern Africa
  'south africa': 710,
  'zambia': 894,
  'zimbabwe': 716,
  'mozambique': 508,
  'malawi': 454,
  'botswana': 72,
  'namibia': 516,
  'lesotho': 426,
  'eswatini': 748, 'swaziland': 748,
  'angola': 24,
  // West Africa
  'nigeria': 566,
  'ghana': 288,
  'senegal': 686,
  "cote d'ivoire": 384, 'ivory coast': 384,
  'guinea-bissau': 624, 'guinea bissau': 624,
  'guinea': 324,
  'sierra leone': 694,
  'liberia': 430,
  'mali': 466,
  'burkina faso': 854,
  'niger': 562,
  'benin': 204,
  'togo': 768,
  'the gambia': 270, 'gambia': 270,
  'cape verde': 132,
  'mauritania': 478,
  // Central Africa
  'cameroon': 120,
  'democratic republic of the congo': 180, 'dr congo': 180, 'drc': 180, 'congo-kinshasa': 180,
  'republic of the congo': 178, 'congo-brazzaville': 178, 'congo': 178,
  'gabon': 266,
  'equatorial guinea': 226,
  'central african republic': 140,
  'chad': 148,
  'sao tome and principe': 678,
  // North Africa
  'egypt': 818,
  'morocco': 504,
  'algeria': 12,
  'tunisia': 788,
  'libya': 434,
  // Unambiguous capital / major cities
  'yerevan': 51,
  'baku': 31,
  'tbilisi': 268,
  'tirana': 8,
  'sarajevo': 70,
  'skopje': 807,
  'podgorica': 499,
  'nicosia': 196,
  'valletta': 470,
  'pristina': 383,
  'yangon': 104, 'rangoon': 104, 'naypyidaw': 104,
  'phnom penh': 116,
  'vientiane': 418,
  'ulaanbaatar': 496,
  'bishkek': 417,
  'dushanbe': 762,
  'ashgabat': 795,
  'kabul': 4,
  'baghdad': 368,
  'damascus': 760,
  'beirut': 422,
  'muscat': 512,
  'manama': 48,
  'sanaa': 887,
  'ramallah': 275,
  'kigali': 646,
  'kampala': 800,
  'lusaka': 894,
  'harare': 716,
  'lilongwe': 454,
  'maputo': 508,
  'windhoek': 516,
  'gaborone': 72,
  'dakar': 686,
  'conakry': 324,
  'freetown': 694,
  'monrovia': 430,
  'abidjan': 384,
  'ouagadougou': 854,
  'bamako': 466,
  'niamey': 562,
  'ndjamena': 148,
  'cotonou': 204,
  'lome': 768,
  'yaounde': 120,
  'libreville': 266,
  'brazzaville': 178,
  'kinshasa': 180,
  'luanda': 24,
  'managua': 558,
  'asuncion': 600,
  'paramaribo': 740,
  'suva': 242,
  'port moresby': 598,
  'mogadishu': 706,
  'asmara': 232,
  'juba': 728,
  'khartoum': 729,
  'antananarivo': 450,
}

// ISO numeric → ISO 3166-1 alpha-2 code (for flag emoji generation)
const COUNTRY_NUM_TO_ALPHA2: Record<number, string> = {
  840: 'US', 826: 'GB', 276: 'DE', 250: 'FR', 124: 'CA', 36: 'AU', 356: 'IN',
  156: 'CN', 76: 'BR', 392: 'JP', 528: 'NL', 752: 'SE', 756: 'CH', 724: 'ES',
  380: 'IT', 643: 'RU', 616: 'PL', 804: 'UA', 792: 'TR', 410: 'KR', 32: 'AR',
  484: 'MX', 360: 'ID', 578: 'NO', 208: 'DK', 246: 'FI', 40: 'AT', 56: 'BE',
  620: 'PT', 203: 'CZ', 642: 'RO', 348: 'HU', 300: 'GR', 376: 'IL', 702: 'SG',
  554: 'NZ', 710: 'ZA', 566: 'NG', 818: 'EG', 586: 'PK', 50: 'BD', 704: 'VN',
  764: 'TH', 458: 'MY', 608: 'PH', 364: 'IR', 170: 'CO', 152: 'CL', 604: 'PE',
  862: 'VE', 703: 'SK', 100: 'BG', 191: 'HR', 688: 'RS', 158: 'TW', 344: 'HK',
  372: 'IE', 352: 'IS', 442: 'LU', 233: 'EE', 428: 'LV', 440: 'LT', 705: 'SI',
  404: 'KE', 288: 'GH', 231: 'ET', 504: 'MA', 788: 'TN', 12: 'DZ', 682: 'SA',
  784: 'AE', 634: 'QA', 400: 'JO', 192: 'CU', 218: 'EC', 68: 'BO', 858: 'UY',
  188: 'CR', 144: 'LK', 524: 'NP', 398: 'KZ', 860: 'UZ', 112: 'BY', 498: 'MD',
  // Caucasus
  51: 'AM', 31: 'AZ', 268: 'GE',
  // Europe additions
  8: 'AL', 20: 'AD', 70: 'BA', 196: 'CY', 438: 'LI', 470: 'MT', 492: 'MC',
  499: 'ME', 807: 'MK', 674: 'SM', 383: 'XK',
  // Central Asia
  417: 'KG', 762: 'TJ', 795: 'TM', 4: 'AF',
  // Middle East
  414: 'KW', 512: 'OM', 48: 'BH', 422: 'LB', 760: 'SY', 887: 'YE', 275: 'PS',
  408: 'KP', 368: 'IQ',
  // South/SE Asia
  64: 'BT', 462: 'MV', 104: 'MM', 116: 'KH', 418: 'LA', 96: 'BN', 496: 'MN', 626: 'TL',
  // Pacific
  598: 'PG', 242: 'FJ', 90: 'SB', 548: 'VU', 882: 'WS', 776: 'TO', 296: 'KI',
  583: 'FM', 584: 'MH', 585: 'PW', 520: 'NR', 798: 'TV',
  // Americas additions
  630: 'PR', 84: 'BZ', 320: 'GT', 340: 'HN', 222: 'SV', 558: 'NI', 591: 'PA',
  332: 'HT', 214: 'DO', 388: 'JM', 780: 'TT', 52: 'BB', 44: 'BS', 308: 'GD',
  28: 'AG', 659: 'KN', 662: 'LC', 670: 'VC', 600: 'PY', 328: 'GY', 740: 'SR',
  // East Africa
  834: 'TZ', 800: 'UG', 646: 'RW', 108: 'BI', 706: 'SO', 262: 'DJ', 232: 'ER',
  728: 'SS', 729: 'SD', 450: 'MG', 480: 'MU', 690: 'SC', 174: 'KM',
  // Southern Africa
  894: 'ZM', 716: 'ZW', 508: 'MZ', 454: 'MW', 72: 'BW', 516: 'NA', 426: 'LS',
  748: 'SZ', 24: 'AO',
  // West Africa
  686: 'SN', 384: 'CI', 624: 'GW', 324: 'GN', 694: 'SL', 430: 'LR', 466: 'ML',
  854: 'BF', 562: 'NE', 204: 'BJ', 768: 'TG', 270: 'GM', 132: 'CV', 478: 'MR',
  // Central & North Africa
  120: 'CM', 180: 'CD', 178: 'CG', 266: 'GA', 226: 'GQ', 140: 'CF', 148: 'TD',
  678: 'ST', 434: 'LY',
}

/** Convert an ISO alpha-2 code to its emoji flag (e.g. "US" → "🇺🇸"). */
function getFlagEmoji(alpha2: string): string {
  return Array.from(alpha2.toUpperCase())
    .map(c => String.fromCodePoint(0x1F1E6 + c.charCodeAt(0) - 65))
    .join('')
}

// Alpha-2 → numeric (reverse of COUNTRY_NUM_TO_ALPHA2), for recognising codes like "AM", "DE".
const ALPHA2_TO_NUM: Record<string, number> = Object.fromEntries(
  Object.entries(COUNTRY_NUM_TO_ALPHA2).map(([num, a2]) => [a2, Number(num)])
)

// Country entries pre-sorted longest-first so specific names beat short ones in substring
// search (prevents "niger" matching inside "nigeria", "mali" inside "somalia", etc.).
const SORTED_COUNTRY_ENTRIES = Object.entries(COUNTRY_NAME_TO_NUM)
  .sort(([a], [b]) => b.length - a.length)

// City (lowercase) → ISO numeric.  Only non-capital / ambiguous cities are listed here;
// capital cities are already in COUNTRY_NAME_TO_NUM above.
const CITY_TO_NUM: Record<string, number> = {
  // ── United States ──────────────────────────────────────────────────────────
  'new york': 840, 'new york city': 840, 'nyc': 840, 'manhattan': 840, 'brooklyn': 840,
  'los angeles': 840, 'la': 840, 'san francisco': 840, 'sf': 840, 'bay area': 840,
  'silicon valley': 840, 'seattle': 840, 'chicago': 840, 'boston': 840, 'austin': 840,
  'denver': 840, 'portland': 840, 'atlanta': 840, 'miami': 840, 'dallas': 840,
  'houston': 840, 'phoenix': 840, 'san diego': 840, 'san jose': 840, 'nashville': 840,
  'minneapolis': 840, 'detroit': 840, 'philadelphia': 840, 'baltimore': 840,
  'charlotte': 840, 'raleigh': 840, 'pittsburgh': 840, 'indianapolis': 840,
  'columbus': 840, 'cleveland': 840, 'kansas city': 840, 'salt lake city': 840,
  'las vegas': 840, 'new orleans': 840, 'memphis': 840, 'richmond': 840,
  'sacramento': 840, 'orlando': 840, 'tampa': 840, 'st. louis': 840,
  'louisville': 840, 'milwaukee': 840, 'cincinnati': 840, 'omaha': 840,
  'albuquerque': 840, 'tucson': 840, 'fresno': 840, 'mesa': 840, 'oakland': 840,
  'tulsa': 840, 'honolulu': 840, 'anchorage': 840, 'boise': 840, 'madison': 840,
  'buffalo': 840, 'jersey city': 840, 'newark': 840, 'st louis': 840,
  'fort worth': 840, 'el paso': 840, 'san antonio': 840,
  // ── United Kingdom ─────────────────────────────────────────────────────────
  'london': 826, 'manchester': 826, 'birmingham': 826, 'leeds': 826, 'glasgow': 826,
  'edinburgh': 826, 'liverpool': 826, 'bristol': 826, 'cardiff': 826, 'belfast': 826,
  'newcastle': 826, 'sheffield': 826, 'nottingham': 826, 'cambridge': 826,
  'oxford': 826, 'brighton': 826, 'coventry': 826, 'leicester': 826, 'bath': 826,
  'exeter': 826, 'york': 826, 'dundee': 826, 'aberdeen': 826, 'southampton': 826,
  // ── Canada ─────────────────────────────────────────────────────────────────
  'toronto': 124, 'vancouver': 124, 'montreal': 124, 'calgary': 124, 'edmonton': 124,
  'winnipeg': 124, 'quebec city': 124, 'hamilton': 124, 'kitchener': 124,
  'victoria': 124, 'halifax': 124, 'london ontario': 124, 'saskatoon': 124,
  'regina': 124, 'st. john\'s': 124,
  // ── Australia ──────────────────────────────────────────────────────────────
  'sydney': 36, 'melbourne': 36, 'brisbane': 36, 'perth': 36, 'adelaide': 36,
  'gold coast': 36, 'newcastle australia': 36, 'hobart': 36, 'darwin': 36,
  // ── Germany ────────────────────────────────────────────────────────────────
  'berlin': 276, 'munich': 276, 'hamburg': 276, 'frankfurt': 276, 'cologne': 276,
  'stuttgart': 276, 'dusseldorf': 276, 'dortmund': 276, 'essen': 276, 'leipzig': 276,
  'bremen': 276, 'dresden': 276, 'hannover': 276, 'nuremberg': 276, 'nurnberg': 276,
  'bonn': 276, 'mannheim': 276, 'karlsruhe': 276, 'augsburg': 276, 'wiesbaden': 276,
  'munster': 276, 'freiburg': 276, 'bielefeld': 276, 'bochum': 276, 'heidelberg': 276,
  'kiel': 276, 'magdeburg': 276, 'mainz': 276,
  // ── France ─────────────────────────────────────────────────────────────────
  'paris': 250, 'lyon': 250, 'marseille': 250, 'toulouse': 250, 'nice': 250,
  'bordeaux': 250, 'strasbourg': 250, 'nantes': 250, 'montpellier': 250,
  'rennes': 250, 'grenoble': 250, 'lille': 250, 'dijon': 250, 'reims': 250,
  'le havre': 250, 'saint-etienne': 250, 'toulon': 250,
  // ── Netherlands ────────────────────────────────────────────────────────────
  'amsterdam': 528, 'rotterdam': 528, 'the hague': 528, 'utrecht': 528,
  'eindhoven': 528, 'groningen': 528, 'tilburg': 528, 'almere': 528,
  'breda': 528, 'nijmegen': 528, 'den haag': 528,
  // ── Sweden ─────────────────────────────────────────────────────────────────
  'stockholm': 752, 'gothenburg': 752, 'malmo': 752, 'goteborg': 752,
  'uppsala': 752, 'linköping': 752, 'vasteras': 752, 'orebro': 752,
  // ── Switzerland ────────────────────────────────────────────────────────────
  'zurich': 756, 'geneva': 756, 'basel': 756, 'lausanne': 756, 'bern': 756,
  // ── Spain ──────────────────────────────────────────────────────────────────
  'madrid': 724, 'barcelona': 724, 'seville': 724, 'valencia': 724, 'bilbao': 724,
  'malaga': 724, 'saragossa': 724, 'zaragoza': 724, 'murcia': 724, 'palma': 724,
  'las palmas': 724, 'granada': 724, 'alicante': 724, 'vigo': 724, 'gijon': 724,
  'cordoba': 724,
  // ── Italy ──────────────────────────────────────────────────────────────────
  'rome': 380, 'milan': 380, 'naples': 380, 'turin': 380, 'florence': 380,
  'venice': 380, 'bologna': 380, 'genoa': 380, 'palermo': 380, 'bari': 380,
  'catania': 380, 'verona': 380, 'trieste': 380, 'padova': 380, 'padua': 380,
  // ── Portugal ───────────────────────────────────────────────────────────────
  'lisbon': 620, 'porto': 620, 'braga': 620, 'coimbra': 620, 'amadora': 620,
  // ── Poland ─────────────────────────────────────────────────────────────────
  'warsaw': 616, 'krakow': 616, 'lodz': 616, 'wroclaw': 616, 'poznan': 616,
  'gdansk': 616, 'szczecin': 616, 'katowice': 616, 'lublin': 616,
  // ── Ukraine ────────────────────────────────────────────────────────────────
  'kyiv': 804, 'kiev': 804, 'kharkiv': 804, 'odessa': 804, 'dnipro': 804,
  'donetsk': 804, 'zaporizhzhia': 804, 'lviv': 804,
  // ── Russia ─────────────────────────────────────────────────────────────────
  'moscow': 643, 'saint petersburg': 643, 'st petersburg': 643, 'novosibirsk': 643,
  'yekaterinburg': 643, 'kazan': 643, 'nizhny novgorod': 643, 'samara': 643,
  'omsk': 643, 'rostov-on-don': 643, 'ufa': 643, 'krasnoyarsk': 643,
  'perm': 643, 'voronezh': 643, 'volgograd': 643,
  // ── Czech Republic ─────────────────────────────────────────────────────────
  'prague': 203, 'brno': 203, 'ostrava': 203, 'plzen': 203,
  // ── Austria ────────────────────────────────────────────────────────────────
  'vienna': 40, 'graz': 40, 'linz': 40, 'salzburg': 40, 'innsbruck': 40,
  // ── Belgium ────────────────────────────────────────────────────────────────
  'brussels': 56, 'antwerp': 56, 'ghent': 56, 'bruges': 56, 'liege': 56,
  // ── Romania ────────────────────────────────────────────────────────────────
  'bucharest': 642, 'cluj-napoca': 642, 'timisoara': 642, 'iasi': 642,
  // ── Hungary ────────────────────────────────────────────────────────────────
  'budapest': 348, 'debrecen': 348, 'pecs': 348,
  // ── Greece ─────────────────────────────────────────────────────────────────
  'athens': 300, 'thessaloniki': 300, 'patras': 300,
  // ── Serbia ─────────────────────────────────────────────────────────────────
  'belgrade': 688, 'novi sad': 688,
  // ── Croatia ────────────────────────────────────────────────────────────────
  'zagreb': 191, 'split': 191,
  // ── Finland ────────────────────────────────────────────────────────────────
  'helsinki': 246, 'espoo': 246, 'tampere': 246, 'turku': 246,
  // ── Denmark ────────────────────────────────────────────────────────────────
  'copenhagen': 208, 'aarhus': 208, 'odense': 208,
  // ── Norway ─────────────────────────────────────────────────────────────────
  'oslo': 578, 'bergen': 578, 'trondheim': 578, 'stavanger': 578,
  // ── Ireland ────────────────────────────────────────────────────────────────
  'dublin': 372, 'cork': 372, 'limerick': 372, 'galway': 372,
  // ── India ──────────────────────────────────────────────────────────────────
  'mumbai': 356, 'delhi': 356, 'new delhi': 356, 'bangalore': 356,
  'bengaluru': 356, 'hyderabad': 356, 'chennai': 356, 'kolkata': 356,
  'calcutta': 356, 'pune': 356, 'ahmedabad': 356, 'jaipur': 356, 'surat': 356,
  'lucknow': 356, 'kanpur': 356, 'nagpur': 356, 'indore': 356, 'bhopal': 356,
  'visakhapatnam': 356, 'patna': 356, 'vadodara': 356, 'ghaziabad': 356,
  'ludhiana': 356, 'agra': 356, 'nashik': 356, 'faridabad': 356, 'meerut': 356,
  'chandigarh': 356, 'coimbatore': 356, 'kochi': 356, 'noida': 356, 'gurgaon': 356,
  'gurugram': 356, 'mysore': 356, 'mysuru': 356, 'thiruvananthapuram': 356,
  'bhubaneswar': 356, 'guwahati': 356,
  // ── China ──────────────────────────────────────────────────────────────────
  'beijing': 156, 'shanghai': 156, 'guangzhou': 156, 'shenzhen': 156,
  'chengdu': 156, 'hangzhou': 156, 'wuhan': 156, "xi'an": 156, 'xian': 156,
  'nanjing': 156, 'tianjin': 156, 'chongqing': 156, 'qingdao': 156,
  'hefei': 156, 'suzhou': 156, 'dongguan': 156, 'foshan': 156, 'zhengzhou': 156,
  'shenyang': 156, 'changsha': 156, 'kunming': 156, 'harbin': 156, 'jinan': 156,
  'dalian': 156, 'shantou': 156, 'nanchang': 156, 'guiyang': 156, 'fuzhou': 156,
  // ── Japan ──────────────────────────────────────────────────────────────────
  'tokyo': 392, 'osaka': 392, 'kyoto': 392, 'yokohama': 392, 'nagoya': 392,
  'sapporo': 392, 'fukuoka': 392, 'kobe': 392, 'kawasaki': 392, 'hiroshima': 392,
  'sendai': 392, 'kitakyushu': 392, 'chiba': 392, 'sakai': 392, 'niigata': 392,
  // ── South Korea ────────────────────────────────────────────────────────────
  'seoul': 410, 'busan': 410, 'incheon': 410, 'daegu': 410, 'daejeon': 410,
  'gwangju': 410, 'suwon': 410, 'ulsan': 410,
  // ── Brazil ─────────────────────────────────────────────────────────────────
  'sao paulo': 76, 'rio de janeiro': 76, 'rio': 76, 'brasilia': 76, 'salvador': 76,
  'fortaleza': 76, 'belo horizonte': 76, 'manaus': 76, 'curitiba': 76,
  'recife': 76, 'porto alegre': 76, 'belem': 76, 'goiania': 76,
  'guarulhos': 76, 'campinas': 76, 'florianopolis': 76,
  // ── Argentina ──────────────────────────────────────────────────────────────
  'buenos aires': 32, 'rosario': 32, 'mendoza': 32,
  'la plata': 32, 'mar del plata': 32, 'tucuman': 32, 'cordoba argentina': 32,
  // ── Mexico ─────────────────────────────────────────────────────────────────
  'mexico city': 484, 'guadalajara': 484, 'monterrey': 484, 'puebla': 484,
  'tijuana': 484, 'leon': 484, 'juarez': 484, 'merida': 484,
  // ── Colombia ───────────────────────────────────────────────────────────────
  'bogota': 170, 'medellin': 170, 'cali': 170, 'barranquilla': 170, 'cartagena': 170,
  // ── Chile ──────────────────────────────────────────────────────────────────
  'santiago': 152, 'valparaiso': 152,
  // ── Peru ───────────────────────────────────────────────────────────────────
  'lima': 604, 'arequipa': 604, 'cusco': 604,
  // ── Venezuela ──────────────────────────────────────────────────────────────
  'caracas': 862, 'maracaibo': 862,
  // ── Israel ─────────────────────────────────────────────────────────────────
  'tel aviv': 376, 'haifa': 376, 'jerusalem': 376, 'beersheba': 376,
  // ── Turkey ─────────────────────────────────────────────────────────────────
  'istanbul': 792, 'ankara': 792, 'izmir': 792, 'bursa': 792, 'antalya': 792,
  'adana': 792, 'konya': 792, 'gaziantep': 792,
  // ── Egypt ──────────────────────────────────────────────────────────────────
  'cairo': 818, 'alexandria': 818, 'giza': 818,
  // ── Pakistan ───────────────────────────────────────────────────────────────
  'karachi': 586, 'lahore': 586, 'faisalabad': 586, 'rawalpindi': 586,
  'peshawar': 586, 'quetta': 586, 'multan': 586,
  // ── Bangladesh ─────────────────────────────────────────────────────────────
  'dhaka': 50, 'chittagong': 50, 'khulna': 50,
  // ── Indonesia ──────────────────────────────────────────────────────────────
  'jakarta': 360, 'surabaya': 360, 'bandung': 360, 'medan': 360, 'yogyakarta': 360,
  'semarang': 360, 'makassar': 360, 'palembang': 360,
  // ── Thailand ───────────────────────────────────────────────────────────────
  'bangkok': 764, 'chiang mai': 764, 'pattaya': 764, 'phuket': 764,
  // ── Vietnam ────────────────────────────────────────────────────────────────
  'ho chi minh city': 704, 'hcmc': 704, 'saigon': 704, 'hanoi': 704, 'ha noi': 704,
  'da nang': 704, 'can tho': 704,
  // ── Philippines ────────────────────────────────────────────────────────────
  'manila': 608, 'quezon city': 608, 'cebu': 608, 'davao': 608, 'makati': 608,
  // ── Malaysia ───────────────────────────────────────────────────────────────
  'kuala lumpur': 458, 'kl': 458, 'petaling jaya': 458, 'penang': 458, 'johor bahru': 458,
  // ── Nigeria ────────────────────────────────────────────────────────────────
  'lagos': 566, 'kano': 566, 'ibadan': 566, 'abuja': 566, 'port harcourt': 566,
  'kaduna': 566, 'enugu': 566, 'benin city': 566,
  // ── Kenya ──────────────────────────────────────────────────────────────────
  'nairobi': 404, 'mombasa': 404, 'kisumu': 404,
  // ── Ethiopia ───────────────────────────────────────────────────────────────
  'addis ababa': 231, 'dire dawa': 231,
  // ── South Africa ───────────────────────────────────────────────────────────
  'johannesburg': 710, 'cape town': 710, 'durban': 710, 'pretoria': 710,
  'port elizabeth': 710, 'gqeberha': 710, 'bloemfontein': 710, 'soweto': 710,
  // ── Morocco ────────────────────────────────────────────────────────────────
  'casablanca': 504, 'rabat': 504, 'fes': 504, 'marrakech': 504, 'agadir': 504,
  // ── Saudi Arabia ───────────────────────────────────────────────────────────
  'riyadh': 682, 'jeddah': 682, 'mecca': 682, 'medina': 682, 'dammam': 682,
  // ── UAE ────────────────────────────────────────────────────────────────────
  'dubai': 784, 'abu dhabi': 784, 'sharjah': 784,
  // ── Sri Lanka ──────────────────────────────────────────────────────────────
  'colombo': 144, 'kandy': 144,
  // ── Nepal ──────────────────────────────────────────────────────────────────
  'kathmandu': 524, 'pokhara': 524,
  // ── New Zealand ────────────────────────────────────────────────────────────
  'auckland': 554, 'christchurch': 554, 'wellington': 554, 'hamilton nz': 554,
  // ── Taiwan ─────────────────────────────────────────────────────────────────
  'taipei': 158, 'kaohsiung': 158, 'taichung': 158,
  // ── Hong Kong ──────────────────────────────────────────────────────────────
  'kowloon': 344, 'hong kong island': 344,
  // ── Singapore (city-state — same as country) already covered ───────────────
  // ── Kazakhstan ─────────────────────────────────────────────────────────────
  'almaty': 398, 'nur-sultan': 398, 'astana': 398,
}

// Reverse map: ISO numeric → canonical display name (title-cased).
// For each numeric code, picks the longest key that has no dots (avoids abbreviations).
const COUNTRY_NUM_TO_NAME: Record<number, string> = (() => {
  const grouped: Record<number, string[]> = {}
  for (const [name, num] of Object.entries(COUNTRY_NAME_TO_NUM)) {
    if (!grouped[num]) grouped[num] = []
    grouped[num].push(name)
  }
  const result: Record<number, string> = {}
  for (const [numStr, names] of Object.entries(grouped)) {
    const canonical = names
      .filter(n => !n.includes('.'))
      .sort((a, b) => b.length - a.length)[0] ?? names[0]
    result[Number(numStr)] = canonical.replace(/\b\w/g, c => c.toUpperCase())
  }
  return result
})()

function numericToAlpha3(num: number): string {
  // World Atlas uses ISO 3166-1 numeric — the TopoJSON stores them as string keys
  return String(num)
}

function getCountryNum(location: string): number | null {
  const lower = location.toLowerCase().trim()

  // 1. Direct full-string match against country names / known capitals
  if (COUNTRY_NAME_TO_NUM[lower] !== undefined) return COUNTRY_NAME_TO_NUM[lower]

  // 2. Direct full-string match against city map (e.g. bare "London", "Chicago")
  if (CITY_TO_NUM[lower] !== undefined) return CITY_TO_NUM[lower]

  // 3. Exact two-letter ISO alpha-2 code (e.g. user wrote "AM", "DE", "GE")
  if (lower.length === 2) {
    const n = ALPHA2_TO_NUM[lower.toUpperCase()]
    if (n !== undefined) return n
  }

  // 4. Comma-split: try each segment right→left (country usually last in "City, Country")
  //    e.g. "London, UK", "Chicago, IL", "Yerevan, Armenia", "San Francisco, CA, USA"
  const parts = lower.split(',').map(p => p.trim()).filter(Boolean)
  if (parts.length > 1) {
    for (let i = parts.length - 1; i >= 0; i--) {
      const part = parts[i]
      if (COUNTRY_NAME_TO_NUM[part] !== undefined) return COUNTRY_NAME_TO_NUM[part]
      if (CITY_TO_NUM[part] !== undefined) return CITY_TO_NUM[part]
      if (part.length === 2) {
        const n = ALPHA2_TO_NUM[part.toUpperCase()]
        if (n !== undefined) return n
      }
    }
  }

  // 5. Whole-word substring search — country names, longest-first to avoid false positives.
  for (const [name, num] of SORTED_COUNTRY_ENTRIES) {
    const escaped = name.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&')
    const re = new RegExp(`(?<![a-z])${escaped}(?![a-z])`)
    if (re.test(lower)) return num
  }

  // 6. Whole-word substring search — city names (catches "I live in Berlin" style strings)
  for (const [city, num] of Object.entries(CITY_TO_NUM)) {
    const escaped = city.replace(/[-[\]{}()*+?.,\\^$|#]/g, '\\$&')
    const re = new RegExp(`(?<![a-z])${escaped}(?![a-z])`)
    if (re.test(lower)) return num
  }

  return null
}

// Interpolate between two hex colours
function interpolateColor(from: string, to: string, t: number): string {
  const parse = (h: string) => [
    parseInt(h.slice(1, 3), 16),
    parseInt(h.slice(3, 5), 16),
    parseInt(h.slice(5, 7), 16),
  ]
  const a = parse(from)
  const b = parse(to)
  const r = Math.round(a[0] + (b[0] - a[0]) * t)
  const g = Math.round(a[1] + (b[1] - a[1]) * t)
  const bl = Math.round(a[2] + (b[2] - a[2]) * t)
  return `rgb(${r},${g},${bl})`
}

interface Props {
  users: UserRecord[]
}

const MIN_ZOOM = 1
const MAX_ZOOM = 8

export default function WorldMap({ users }: Props) {
  const [tooltip, setTooltip] = useState<{ country: string; count: number } | null>(null)
  const [zoom, setZoom] = useState(1)
  const [selected, setSelected] = useState<{ label: string; users: UserRecord[] } | null>(null)
  const [highlightedNum, setHighlightedNum] = useState<number | null>(null)

  function zoomIn() { setZoom(z => Math.min(z * 1.5, MAX_ZOOM)) }
  function zoomOut() { setZoom(z => Math.max(z / 1.5, MIN_ZOOM)) }
  function resetZoom() { setZoom(1) }

  // Build country → count from location_normalized
  const countryCounts = useMemo(() => {
    const counts: Record<number, number> = {}
    for (const u of users) {
      const loc = u.location_normalized ?? u.location
      if (!loc) continue
      const num = getCountryNum(loc)
      if (num !== null) counts[num] = (counts[num] ?? 0) + 1
    }
    return counts
  }, [users])

  // Build country → users list
  const countryUsers = useMemo(() => {
    const map: Record<number, UserRecord[]> = {}
    for (const u of users) {
      const loc = u.location_normalized ?? u.location
      if (!loc) continue
      const num = getCountryNum(loc)
      if (num !== null) {
        if (!map[num]) map[num] = []
        map[num].push(u)
      }
    }
    return map
  }, [users])

  const maxCount = useMemo(() => Math.max(1, ...Object.values(countryCounts)), [countryCounts])

  // Build tooltip-friendly name map (numeric → first location string that matched it)
  const countryLabel = useMemo(() => {
    const m: Record<number, string> = {}
    for (const u of users) {
      const loc = u.location_normalized ?? u.location
      if (!loc) continue
      const num = getCountryNum(loc)
      if (num !== null && !m[num]) m[num] = loc
    }
    return m
  }, [users])

  // Sorted list of countries that have at least one user, for the dropdown
  const countryOptions = useMemo(() =>
    Object.keys(countryCounts)
      .map(k => Number(k))
      .sort((a, b) => (COUNTRY_NUM_TO_NAME[a] ?? '').localeCompare(COUNTRY_NUM_TO_NAME[b] ?? '')),
  [countryCounts])

  if (Object.keys(countryCounts).length === 0) return null

  return (
    <div className="card">
      <h3 className="text-sm font-semibold gradient-heading mb-1 flex items-center gap-1.5">
        🌍 World Map
      </h3>
      <p className="text-xs text-gray-500 mb-3">User density by country. Scroll to zoom, drag to pan.</p>

      {/* Country selector dropdown */}
      <div className="mb-3">
        <select
          value={highlightedNum ?? ''}
          onChange={e => setHighlightedNum(e.target.value ? Number(e.target.value) : null)}
          className="w-full text-xs rounded-lg px-3 py-2 text-gray-200 transition-all focus:outline-hidden focus:ring-1 focus:ring-purple-500"
          style={{ background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.10)' }}
        >
          <option value="">All countries ({countryOptions.length})</option>
          {countryOptions.map(num => {
              const alpha2 = COUNTRY_NUM_TO_ALPHA2[num]
              const flag = alpha2 ? getFlagEmoji(alpha2) + ' ' : ''
              return (
                <option key={num} value={num} style={{ background: '#1a1030' }}>
                  {flag}{COUNTRY_NUM_TO_NAME[num] ?? String(num)} — {countryCounts[num]} user{countryCounts[num] !== 1 ? 's' : ''}
                </option>
              )
            })}
        </select>
      </div>

      {/* Legend + zoom controls */}
      <div className="flex items-center justify-between mb-3 flex-wrap gap-2">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <span>0</span>
          <div className="w-32 h-2 rounded-sm" style={{
            background: 'linear-gradient(to right, #1e1b4b, #7c3aed)',
          }} />
          <span>{maxCount} users</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={zoomOut}
            disabled={zoom <= MIN_ZOOM}
            className="w-7 h-7 rounded-sm flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all text-base leading-none"
            title="Zoom out"
          >−</button>
          <button
            onClick={resetZoom}
            className="px-2 h-7 rounded-sm text-xs text-gray-400 hover:text-white hover:bg-white/10 transition-all font-mono"
            title="Reset zoom"
          >{zoom.toFixed(1)}×</button>
          <button
            onClick={zoomIn}
            disabled={zoom >= MAX_ZOOM}
            className="w-7 h-7 rounded-sm flex items-center justify-center text-gray-400 hover:text-white hover:bg-white/10 disabled:opacity-30 disabled:cursor-not-allowed transition-all text-base leading-none"
            title="Zoom in"
          >+</button>
        </div>
      </div>

      {tooltip && (
        <div
          className="absolute z-50 text-xs rounded-lg px-3 py-1.5 pointer-events-none"
          style={{
            background: 'rgba(14,10,36,0.95)',
            border: '1px solid rgba(139,92,246,0.3)',
            color: '#e5e7eb',
          }}
        >
          <span className="font-semibold">{tooltip.country}</span>: {tooltip.count} user{tooltip.count !== 1 ? 's' : ''}
        </div>
      )}

      <div className="relative w-full overflow-hidden rounded-lg" style={{ background: 'rgba(255,255,255,0.02)' }}>
        <ComposableMap
          projection="geoNaturalEarth1"
          style={{ width: '100%', height: 'auto' }}
        >
          <ZoomableGroup zoom={zoom} onMoveEnd={({ zoom: z }) => setZoom(z)} minZoom={MIN_ZOOM} maxZoom={MAX_ZOOM}>
            <Geographies geography={GEO_URL}>
              {({ geographies }) =>
                geographies.map(geo => {
                  const num = parseInt(geo.id, 10)
                  const count = countryCounts[num] ?? 0
                  const t = count > 0 ? Math.pow(count / maxCount, 0.5) : 0
                  const isHighlighted = num === highlightedNum
                  const fill = isHighlighted
                    ? '#f59e0b'
                    : count > 0
                      ? interpolateColor('#2e1065', '#a855f7', t)
                      : 'rgba(255,255,255,0.04)'
                  const stroke = isHighlighted ? '#fcd34d' : 'rgba(255,255,255,0.08)'
                  const strokeWidth = isHighlighted ? 1.5 : 0.5

                  return (
                    <Geography
                      key={geo.rsmKey}
                      geography={geo}
                      fill={fill}
                      stroke={stroke}
                      strokeWidth={strokeWidth}
                      style={{
                        default: { outline: 'none' },
                        hover: {
                          outline: 'none',
                          fill: isHighlighted ? '#fbbf24' : count > 0 ? interpolateColor('#2e1065', '#c084fc', t) : 'rgba(255,255,255,0.08)',
                          cursor: count > 0 ? 'pointer' : 'default',
                        },
                        pressed: { outline: 'none' },
                      }}
                      onMouseEnter={() => {
                        if (count > 0) setTooltip({ country: countryLabel[num] ?? String(num), count })
                      }}
                      onMouseLeave={() => setTooltip(null)}
                      onClick={() => {
                        if (count > 0) {
                          setHighlightedNum(isHighlighted ? null : num)
                          setSelected({ label: countryLabel[num] ?? String(num), users: countryUsers[num] ?? [] })
                        }
                      }}
                    />
                  )
                })
              }
            </Geographies>
          </ZoomableGroup>
        </ComposableMap>
      </div>

      {/* Country users modal */}
      {selected && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4"
          style={{ background: 'rgba(0,0,0,0.6)', backdropFilter: 'blur(4px)' }}
          onClick={() => setSelected(null)}
        >
          <div
            className="relative w-full max-w-lg max-h-[80vh] flex flex-col rounded-2xl overflow-hidden"
            style={{ background: '#0f0a1e', border: '1px solid rgba(139,92,246,0.25)' }}
            onClick={e => e.stopPropagation()}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-4 border-b border-white/5">
              <div>
                <h2 className="text-sm font-semibold text-white capitalize">{selected.label}</h2>
                <p className="text-xs text-gray-500 mt-0.5">{selected.users.length} user{selected.users.length !== 1 ? 's' : ''}</p>
              </div>
              <button
                onClick={() => setSelected(null)}
                className="p-1.5 rounded-lg text-gray-500 hover:text-white hover:bg-white/10 transition-all"
              >
                <X size={16} />
              </button>
            </div>

            {/* User list */}
            <div className="overflow-y-auto flex-1 px-3 py-3 space-y-1">
              {selected.users.map(u => (
                <a
                  key={u.login}
                  href={u.html_url ?? `https://github.com/${u.login}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-white/5 transition-all group"
                >
                  {u.avatar_url
                    ? <img src={u.avatar_url} alt={u.login} className="w-8 h-8 rounded-full shrink-0 opacity-90 group-hover:opacity-100" />
                    : <div className="w-8 h-8 rounded-full shrink-0 bg-purple-900/50 flex items-center justify-center text-xs text-purple-300">{u.login[0].toUpperCase()}</div>
                  }
                  <div className="flex-1 min-w-0">
                    <div className="text-sm text-white font-medium truncate group-hover:text-purple-300 transition-colors">
                      {u.name || u.login}
                    </div>
                    <div className="text-xs text-gray-500 truncate">@{u.login}{u.company_normalized ? ` · ${u.company_normalized}` : ''}</div>
                  </div>
                  <div className="flex flex-col items-end gap-1 shrink-0">
                    {u.followers != null && (
                      <span className="text-xs text-gray-500">{u.followers.toLocaleString()} followers</span>
                    )}
                    {u.roles && u.roles.length > 0 && (
                      <div className="flex gap-1 flex-wrap justify-end">
                        {u.roles.slice(0, 2).map(r => (
                          <span key={r} className="text-[10px] px-1.5 py-0.5 rounded-full bg-purple-900/50 text-purple-300">{r}</span>
                        ))}
                      </div>
                    )}
                  </div>
                </a>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
