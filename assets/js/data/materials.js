/*
 * Material definitions for the configurator.
 *
 * Each material declares which colour collection its "View Available Colours"
 * button opens, plus the spec sheet rendered in the detail panel.
 */
window.CM = window.CM || {};

CM.materials = [
  {
    id: 'smp-26',
    name: '26 Gauge SMP Steel',
    short: '26g SMP',
    kicker: 'Silicone-Modified Polyester',
    collection: 'smp',
    swatch: '#5B6167',
    accent: '#7C8A96',
    summary:
      'The workhorse of residential sheet metal. A 26 gauge SMP panel gives you the full Classic colour ' +
      'collection at the most accessible price point, with a hard, chalk-resistant baked finish that holds ' +
      'up well on chimney caps, flashing and trim.',
    specs: [
      { label: 'Available Gauges', value: '26 ga (0.0187" nominal)', detail: 'Stocked in coil and flat sheet, 40.5" and 48" widths.' },
      { label: 'Finish Description', value: 'Silicone-modified polyester, baked', detail: 'Blended polyester with silicone agents for gloss retention. G90 galvanized or Galvalume substrate.' },
      { label: 'Best Applications', value: 'Residential caps, flashing, trim', detail: 'Custom chimney caps, counter flashing, wall caps, drip edge, valley and accessory trim.' },
      { label: 'Warranty', value: 'Up to 40-year limited paint film', detail: 'Covers film integrity, chalk and fade within stated limits. Terms vary by colour and region.' },
      { label: 'Thickness', value: '0.0187" / 0.475 mm', detail: 'Lightest stocked steel gauge. Best on smaller pans and well-supported profiles.' },
      { label: 'Durability', value: 'Good', detail: 'Hard finish with strong scratch resistance. More prone to oil-canning and denting than heavier gauges.' },
      { label: 'Cost Category', value: '$ — Entry', detail: 'Lowest installed cost of the painted steel options.' },
      { label: 'Maintenance', value: 'Low — annual rinse', detail: 'Rinse to clear debris and salts. Touch up field cuts and scratches to prevent edge creep.' }
    ]
  },
  {
    id: 'smp-24',
    name: '24 Gauge SMP Steel',
    short: '24g SMP',
    kicker: 'Silicone-Modified Polyester',
    collection: 'smp',
    swatch: '#4E555C',
    accent: '#7C8A96',
    summary:
      'The standard specification for custom chimney caps. The step up from 26 gauge buys noticeably flatter ' +
      'pans, cleaner brake lines and far better dent resistance — for a small premium and the same Classic ' +
      'colour collection.',
    specs: [
      { label: 'Available Gauges', value: '24 ga (0.0236" nominal)', detail: 'Stocked in coil and flat sheet, 40.5" and 48" widths.' },
      { label: 'Finish Description', value: 'Silicone-modified polyester, baked', detail: 'Identical coating chemistry to 26 gauge on a heavier base metal.' },
      { label: 'Best Applications', value: 'Custom caps, large flashings, coping', detail: 'The default for fabricated chimney caps, wide counter flashing runs and wall coping.' },
      { label: 'Warranty', value: 'Up to 40-year limited paint film', detail: 'Same paint warranty as 26 gauge; heavier substrate improves long-term panel performance.' },
      { label: 'Thickness', value: '0.0236" / 0.60 mm', detail: 'About 26% thicker than 26 gauge. Holds a crisp break and resists oil-canning.' },
      { label: 'Durability', value: 'Very Good', detail: 'Markedly better dent and hail resistance. Spans wider without stiffeners.' },
      { label: 'Cost Category', value: '$$ — Standard', detail: 'Modest premium over 26 gauge; the best value in painted steel.' },
      { label: 'Maintenance', value: 'Low — annual rinse', detail: 'Rinse annually, inspect sealant joints and fasteners, touch up field cuts.' }
    ]
  },
  {
    id: 'smp-22',
    name: '22 Gauge SMP Steel',
    short: '22g SMP',
    kicker: 'Silicone-Modified Polyester',
    collection: 'smp',
    swatch: '#414850',
    accent: '#7C8A96',
    summary:
      'Heavy-gauge painted steel for oversized and structurally demanding work. Where a cap spans a wide flue ' +
      'or a coping run has to stay dead flat over distance, 22 gauge is the answer in the Classic colour range.',
    specs: [
      { label: 'Available Gauges', value: '22 ga (0.0299" nominal)', detail: 'Mill order in Classic colours; lead time applies on less common colours.' },
      { label: 'Finish Description', value: 'Silicone-modified polyester, baked', detail: 'Same SMP system, specified where panel rigidity governs.' },
      { label: 'Best Applications', value: 'Oversized caps, commercial coping', detail: 'Large multi-flue caps, long coping runs, high-wind and heavy-snow exposures.' },
      { label: 'Warranty', value: 'Up to 40-year limited paint film', detail: 'Paint warranty as per Classic SMP; substrate carries its own galvanizing warranty.' },
      { label: 'Thickness', value: '0.0299" / 0.76 mm', detail: 'Roughly 60% thicker than 26 gauge. Very high stiffness per unit width.' },
      { label: 'Durability', value: 'Excellent', detail: 'Top of the painted steel range for impact and deflection resistance.' },
      { label: 'Cost Category', value: '$$$ — Premium steel', detail: 'Higher material and freight cost; specified where the span demands it.' },
      { label: 'Maintenance', value: 'Low — annual rinse', detail: 'Same care as lighter gauges. Heavier metal tolerates ladder and service contact better.' }
    ]
  },
  {
    id: 'pvdf-24',
    name: '24 Gauge PVDF Steel',
    short: '24g PVDF',
    kicker: 'Kynar 500 / Hylar 5000 class',
    collection: 'pvdf',
    swatch: '#3A4552',
    accent: '#9AAFC4',
    summary:
      'Architectural-grade coating on the standard fabrication gauge. PVDF is what an architect means by ' +
      '"Kynar" — the resin system that holds colour on a south elevation for decades instead of years.',
    highlights: [
      'Premium architectural coating',
      'Superior fade resistance',
      'Luxury residential',
      'Commercial projects',
      'Longest colour retention',
      'Excellent UV resistance',
      'Coastal environments'
    ],
    specs: [
      { label: 'Available Gauges', value: '24 ga (0.0236" nominal)', detail: 'Stocked in the Signature colour collection, coil and flat sheet.' },
      { label: 'Finish Description', value: '70% PVDF resin, architectural', detail: 'Fluoropolymer coating with ceramic and inorganic pigments. Kynar 500 / Hylar 5000 class.' },
      { label: 'Best Applications', value: 'Luxury residential, commercial, coastal', detail: 'Standing seam caps, architectural flashing, coping and specification-driven work.' },
      { label: 'Warranty', value: '30–40 year film, fade & chalk covered', detail: 'Fade and chalk limits are the differentiator — PVDF warranties quantify colour retention in Hunter Delta E units.' },
      { label: 'Thickness', value: '0.0236" / 0.60 mm', detail: 'Same base metal as 24 gauge SMP; the coating is the upgrade.' },
      { label: 'Durability', value: 'Excellent (coating)', detail: 'Outstanding UV, chemical and salt-spray resistance. Slightly softer film than SMP, so it marks more easily during handling.' },
      { label: 'Cost Category', value: '$$$ — Architectural', detail: 'Typically 20–40% above SMP in the same gauge.' },
      { label: 'Maintenance', value: 'Very low — rinse, no recoating', detail: 'Annual rinse; twice yearly within a few kilometres of salt water. No recoating within the warranty term.' }
    ]
  },
  {
    id: 'pvdf-22',
    name: '22 Gauge PVDF Steel',
    short: '22g PVDF',
    kicker: 'Kynar 500 / Hylar 5000 class',
    collection: 'pvdf',
    swatch: '#333D49',
    accent: '#9AAFC4',
    summary:
      'The top of the painted steel range: architectural PVDF colour retention on the heaviest stocked gauge. ' +
      'Specified where a project needs both a fifty-year colour expectation and a panel that will not move.',
    highlights: [
      'Premium architectural coating',
      'Superior fade resistance',
      'Luxury residential',
      'Commercial projects',
      'Longest colour retention',
      'Excellent UV resistance',
      'Coastal environments'
    ],
    specs: [
      { label: 'Available Gauges', value: '22 ga (0.0299" nominal)', detail: 'Mill order in the Signature collection; minimum quantities and lead time apply.' },
      { label: 'Finish Description', value: '70% PVDF resin, architectural', detail: 'Same fluoropolymer system as 24 gauge on a heavier substrate.' },
      { label: 'Best Applications', value: 'Monumental caps, commercial coping', detail: 'Large-format architectural metal, exposed coping, high-wind coastal elevations.' },
      { label: 'Warranty', value: '30–40 year film, fade & chalk covered', detail: 'Full architectural warranty package; often paired with a project-specific finish warranty.' },
      { label: 'Thickness', value: '0.0299" / 0.76 mm', detail: 'Maximum stiffness in painted steel. Stays flat across long unsupported runs.' },
      { label: 'Durability', value: 'Excellent', detail: 'Best combination of impact resistance and coating performance in the steel range.' },
      { label: 'Cost Category', value: '$$$$ — Specification grade', detail: 'Highest cost of the steel options; competitive with aluminum on a delivered basis.' },
      { label: 'Maintenance', value: 'Very low — rinse, no recoating', detail: 'Annual rinse, twice yearly in coastal exposure. Inspect sealed joints at five-year intervals.' }
    ]
  },
  {
    id: 'aluminum',
    name: 'Aluminum',
    short: 'Aluminum',
    kicker: 'PVDF-coated 3105 / 3003 alloy',
    collection: 'aluminum',
    swatch: '#8D959B',
    accent: '#C3CCD3',
    summary:
      'When the building is near salt water, aluminum stops being an upgrade and starts being the correct ' +
      'answer. It cannot rust, it weighs roughly a third of steel, and it takes the same PVDF architectural ' +
      'coating as the Signature steel range.',
    highlights: [
      'Lightweight',
      'Corrosion resistant',
      'Marine environments',
      'Premium finish',
      'Architectural applications'
    ],
    specs: [
      { label: 'Available Gauges', value: '.032" and .040" typical', detail: 'Aluminum is specified by decimal thickness, not gauge. .050" available for large-format work.' },
      { label: 'Finish Description', value: '70% PVDF over aluminum', detail: 'Polar White, Charcoal and Weathered Zinc stocked; balance of the Signature range by mill order.' },
      { label: 'Best Applications', value: 'Marine and coastal, architectural', detail: 'Oceanfront chimney caps, wall caps, coping, flashing and any assembly exposed to salt spray.' },
      { label: 'Warranty', value: '30–40 year film + no-rust substrate', detail: 'Aluminum does not carry a red-rust exclusion, which is the practical advantage over steel at the coast.' },
      { label: 'Thickness', value: '0.032" / 0.81 mm typical', detail: 'Thicker than equivalent-strength steel because aluminum is less stiff per unit thickness.' },
      { label: 'Durability', value: 'Excellent corrosion, softer metal', detail: 'Immune to red rust. Dents more readily than steel at equivalent stiffness, so gauge up on exposed faces.' },
      { label: 'Cost Category', value: '$$$$ — Premium', detail: 'Higher per pound than steel, partly offset by lower shipping weight and longer coastal service life.' },
      { label: 'Maintenance', value: 'Very low', detail: 'Rinse twice yearly in marine exposure. Isolate from dissimilar metals to avoid galvanic contact.' }
    ]
  },
  {
    id: 'copper',
    name: 'Copper',
    short: 'Copper',
    kicker: '16 oz & 20 oz architectural sheet',
    collection: 'copper',
    swatch: '#B87036',
    accent: '#E0A26A',
    summary:
      'A living finish. Copper is the only material here that keeps changing after installation — from mill ' +
      'bright through russet and chocolate brown to the verdigris green that makes it unmistakable. It is ' +
      'also, measured in centuries, the longest-lived option on the list.',
    highlights: [
      'Natural Copper',
      'Weathered Copper',
      'Patina develops on the building',
      'Century-plus service life',
      'Fully recyclable'
    ],
    specs: [
      { label: 'Available Gauges', value: '16 oz (.0216") and 20 oz (.027")', detail: 'Copper is specified by weight per square foot. 16 oz is standard; 20 oz for large or exposed work.' },
      { label: 'Finish Description', value: 'Uncoated mill finish or pre-patinated', detail: 'No paint film. The surface is the material, and it weathers in place.' },
      { label: 'Best Applications', value: 'Heritage, luxury, standing seam caps', detail: 'Signature chimney caps, bay roofs, heritage restoration, decorative flashing and finials.' },
      { label: 'Warranty', value: 'No paint warranty — material life 100+ yrs', detail: 'There is no coating to warrant. Copper roofs commonly outlast the structures beneath them.' },
      { label: 'Thickness', value: '0.0216" (16 oz) typical', detail: 'Soft and highly formable — the reason copper suits ornamental brakes and hand-formed detail.' },
      { label: 'Durability', value: 'Exceptional', detail: 'Self-protecting oxide layer. Soft surface marks easily when new; marks disappear as the patina develops.' },
      { label: 'Cost Category', value: '$$$$$ — Luxury', detail: 'Highest material cost, and it tracks commodity copper pricing. Quote validity is short.' },
      { label: 'Maintenance', value: 'None — do not clean', detail: 'Leave it alone. Cleaning or polishing resets the patina. Avoid copper runoff onto adjacent stone or aluminum.' }
    ]
  },
  {
    id: 'zinc',
    name: 'Zinc',
    short: 'Zinc',
    kicker: 'Rolled zinc-copper-titanium',
    collection: 'zinc',
    swatch: '#8C918D',
    accent: '#B7BDB9',
    summary:
      'The quiet luxury choice. Architectural zinc has a self-healing surface — scratches close over as the ' +
      'patina re-forms — a service life measured in generations, and a soft matte grey that European ' +
      'architects have specified for over a century.',
    highlights: [
      'Natural Zinc',
      'Pre-weathered Zinc',
      'Quartz Zinc',
      'Anthra Zinc',
      'Self-healing surface',
      'Extremely long lifespan',
      'Low maintenance',
      'Luxury architectural appearance'
    ],
    specs: [
      { label: 'Available Gauges', value: '0.7 mm and 0.8 mm standard', detail: '0.7 mm for most flashing and cap work; 0.8 mm for large panels and coping.' },
      { label: 'Finish Description', value: 'Natural, pre-weathered, Quartz, Anthra', detail: 'Uncoated rolled alloy. Pre-weathered finishes are chemically patinated at the mill.' },
      { label: 'Best Applications', value: 'Luxury architectural, contemporary', detail: 'Standing seam caps, wall cladding, coping, contemporary residential and institutional work.' },
      { label: 'Warranty', value: 'No coating warranty — 80–100+ yr life', detail: 'Like copper, zinc has no paint film to fail. Service life is governed by thickness and detailing.' },
      { label: 'Thickness', value: '0.7 mm / 0.0276" typical', detail: 'Requires allowance for thermal movement — zinc moves more than steel and detailing must permit it.' },
      { label: 'Durability', value: 'Excellent, self-healing', detail: 'The patina re-forms over scratches, so minor handling damage disappears over months.' },
      { label: 'Cost Category', value: '$$$$$ — Luxury', detail: 'Comparable to copper. Skilled installation is required and adds to installed cost.' },
      { label: 'Maintenance', value: 'Essentially none', detail: 'No cleaning required. Keep free-draining — standing water and trapped moisture on the back face are the failure mode.' }
    ]
  }
];

/*
 * Comparison matrix.
 * Rating rows use a 1-5 scale rendered as an animated meter.
 * Text rows render as-is.
 */
CM.comparison = {
  materials: ['smp-26', 'smp-24', 'smp-22', 'pvdf-24', 'pvdf-22', 'aluminum', 'copper', 'zinc'],
  rows: [
    {
      id: 'price', label: 'Price', icon: 'price', type: 'text',
      hint: 'Relative installed cost. More symbols means higher cost.',
      values: {
        'smp-26': '$', 'smp-24': '$$', 'smp-22': '$$$', 'pvdf-24': '$$$',
        'pvdf-22': '$$$$', 'aluminum': '$$$$', 'copper': '$$$$$', 'zinc': '$$$$$'
      }
    },
    {
      id: 'weight', label: 'Weight', icon: 'weight', type: 'text',
      hint: 'Approximate weight per square foot as installed.',
      values: {
        'smp-26': '0.91 lb/ft²', 'smp-24': '1.16 lb/ft²', 'smp-22': '1.41 lb/ft²',
        'pvdf-24': '1.16 lb/ft²', 'pvdf-22': '1.41 lb/ft²', 'aluminum': '0.46 lb/ft²',
        'copper': '1.00 lb/ft²', 'zinc': '1.02 lb/ft²'
      }
    },
    {
      id: 'durability', label: 'Durability', icon: 'shield', type: 'rating',
      hint: 'Overall resistance to impact, deflection and service handling.',
      values: { 'smp-26': 3, 'smp-24': 4, 'smp-22': 5, 'pvdf-24': 4, 'pvdf-22': 5, 'aluminum': 3, 'copper': 4, 'zinc': 4 }
    },
    {
      id: 'warranty', label: 'Warranty', icon: 'certificate', type: 'text',
      hint: 'Limited paint film warranty, or material service expectation where no coating exists.',
      values: {
        'smp-26': 'Up to 40 yr', 'smp-24': 'Up to 40 yr', 'smp-22': 'Up to 40 yr',
        'pvdf-24': '30–40 yr', 'pvdf-22': '30–40 yr', 'aluminum': '30–40 yr',
        'copper': 'No coating', 'zinc': 'No coating'
      }
    },
    {
      id: 'fade', label: 'Fade Resistance', icon: 'sun', type: 'rating',
      hint: 'Colour retention under UV exposure over the warranty term.',
      values: { 'smp-26': 3, 'smp-24': 3, 'smp-22': 3, 'pvdf-24': 5, 'pvdf-22': 5, 'aluminum': 5, 'copper': 5, 'zinc': 5 },
      footnotes: { 'copper': 'Not applicable — copper changes colour by design.', 'zinc': 'Not applicable — uncoated patina.' }
    },
    {
      id: 'scratch', label: 'Scratch Resistance', icon: 'diamond', type: 'rating',
      hint: 'Resistance to marking during fabrication, transport and installation.',
      values: { 'smp-26': 5, 'smp-24': 5, 'smp-22': 5, 'pvdf-24': 3, 'pvdf-22': 3, 'aluminum': 3, 'copper': 2, 'zinc': 4 },
      footnotes: { 'zinc': 'Self-healing — scratches close as the patina re-forms.', 'copper': 'Marks show when new, then disappear into the patina.' }
    },
    {
      id: 'corrosion', label: 'Corrosion Resistance', icon: 'droplet', type: 'rating',
      hint: 'Resistance to rust, salt and chemical attack.',
      values: { 'smp-26': 3, 'smp-24': 3, 'smp-22': 3, 'pvdf-24': 4, 'pvdf-22': 4, 'aluminum': 5, 'copper': 5, 'zinc': 5 }
    },
    {
      id: 'coastal', label: 'Coastal Performance', icon: 'wave', type: 'rating',
      hint: 'Suitability within a few kilometres of salt water.',
      values: { 'smp-26': 2, 'smp-24': 2, 'smp-22': 2, 'pvdf-24': 4, 'pvdf-22': 4, 'aluminum': 5, 'copper': 5, 'zinc': 4 },
      footnotes: { 'zinc': 'Excellent, but requires ventilated back face in marine air.' }
    },
    {
      id: 'lifespan', label: 'Expected Lifespan', icon: 'clock', type: 'text',
      hint: 'Realistic service life with correct detailing and normal exposure.',
      values: {
        'smp-26': '25–40 yr', 'smp-24': '30–45 yr', 'smp-22': '35–50 yr',
        'pvdf-24': '40–60 yr', 'pvdf-22': '45–60 yr', 'aluminum': '50–70 yr',
        'copper': '100+ yr', 'zinc': '80–100+ yr'
      }
    },
    {
      id: 'maintenance', label: 'Maintenance', icon: 'wrench', type: 'rating',
      hint: 'Higher is better — 5 means essentially no maintenance required.',
      values: { 'smp-26': 4, 'smp-24': 4, 'smp-22': 4, 'pvdf-24': 5, 'pvdf-22': 5, 'aluminum': 5, 'copper': 5, 'zinc': 5 }
    },
    {
      id: 'architect', label: 'Architect Recommended', icon: 'compass', type: 'rating',
      hint: 'How often the material appears in specification-driven architectural work.',
      values: { 'smp-26': 2, 'smp-24': 3, 'smp-22': 3, 'pvdf-24': 5, 'pvdf-22': 5, 'aluminum': 5, 'copper': 5, 'zinc': 5 }
    },
    {
      id: 'luxury', label: 'Luxury Rating', icon: 'star', type: 'rating',
      hint: 'Perceived quality and presence of the finished installation.',
      values: { 'smp-26': 2, 'smp-24': 3, 'smp-22': 3, 'pvdf-24': 4, 'pvdf-22': 4, 'aluminum': 4, 'copper': 5, 'zinc': 5 }
    }
  ]
};

/*
 * Services offered. The index is shown in the UI — it reads as a catalogue
 * of nine, not a sequence, so nothing depends on the order beyond display.
 */
CM.services = [
  {
    id: 'chimney-caps',
    name: 'Custom Chimney Caps',
    body: 'Precision-fabricated chimney caps in steel, copper and zinc. Flat-top, louvered and ' +
          'pyramid profiles — built to shed water and protect your investment.'
  },
  {
    id: 's-lock',
    name: 'S-Lock Flashing System',
    body: 'Our signature interlocking flashing profile. Fewer screw penetrations means fewer ' +
          'opportunities for water seepage — superior protection with a cleaner look.'
  },
  {
    id: 'copper-gutter',
    name: 'Copper Gutter Systems',
    body: 'Distributor for Euracraft Tecu copper gutter systems — 18 oz European-style gutters in ' +
          '5" and 6". Fully soldered seams, classic architectural appeal.'
  },
  {
    id: 'aluminum-flashing',
    name: 'Aluminum Flashing',
    body: 'Corrosion-resistant aluminum wall and roof flashing. Ideal for coastal and industrial ' +
          'environments.'
  },
  {
    id: 'standing-seam',
    name: 'Standing Seam Components',
    body: 'Custom standing seam chimney enclosures, roof accessories and architectural trim pieces.'
  },
  {
    id: 'panels',
    name: 'Metal Wall & Roof Panels',
    body: 'Roll-formed prepainted steel panels cut to length for walls, roofs and soffit — ' +
          'board-and-batten, lap siding, plank and standing rib profiles in over 80 colours and ' +
          'woodgrain finishes. Supplied with the closures, trims, clips and fasteners the ' +
          'installation calls for.'
  },
  {
    id: 'commercial',
    name: 'Commercial Sheet Metal',
    body: 'Large-scale fabrication for commercial projects. HVAC enclosures, ductwork and custom ' +
          'assemblies.'
  }
];

/* Where quote requests are addressed. Change this one line to reroute them. */
CM.quoteEmail = 'quotes@esthers.example';

CM.projectTypes = ['Residential', 'Commercial', 'Historic restoration', 'Not sure yet'];
CM.timelines = ['As soon as possible', 'Within 1–3 months', 'Within 3–6 months', 'Planning / budgeting stage'];
