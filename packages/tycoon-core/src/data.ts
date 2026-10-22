// The game's content: generators, upgrades and achievements. Changing any number here changes
// the rules, so bump RULES_VERSION (rules.ts) in the same change (docs/04-pipeline-tycoon.md §2.1).

export interface Generator {
  readonly id: string;
  readonly name: string;
  /** Short flavour line for the shop. */
  readonly blurb: string;
  readonly baseCost: number;
  /** Records per second for one, before multipliers. */
  readonly rate: number;
}

/** The ten tiers, cheapest first. A tier's index is its id in actions and state. */
export const GENERATORS: readonly Generator[] = [
  {
    id: "intern",
    name: "Intern",
    blurb: "Copy-pastes CSVs by hand. Mostly correctly.",
    baseCost: 15,
    rate: 0.1,
  },
  {
    id: "cron",
    name: "Cron job",
    blurb: "A script that runs every minute. In UTC, hopefully.",
    baseCost: 100,
    rate: 1,
  },
  {
    id: "sftp",
    name: "SFTP drop folder",
    blurb: "Files appear. Files vanish. Nobody asks.",
    baseCost: 1_100,
    rate: 8,
  },
  {
    id: "rest",
    name: "REST connector",
    blurb: "GET, transform, POST. Retry on 503.",
    baseCost: 12_000,
    rate: 47,
  },
  {
    id: "queue",
    name: "Message queue",
    blurb: "Decoupled, durable, delivered at least once.",
    baseCost: 130_000,
    rate: 260,
  },
  {
    id: "etl",
    name: "ETL cluster",
    blurb: "Extract, transform, load, page someone at 3 a.m.",
    baseCost: 1_400_000,
    rate: 1_400,
  },
  {
    id: "lake",
    name: "Data lake",
    blurb: "Everything goes in. Some of it comes out.",
    baseCost: 20_000_000,
    rate: 7_800,
  },
  {
    id: "mesh",
    name: "Multi-region mesh",
    blurb: "Active-active on three continents.",
    baseCost: 330_000_000,
    rate: 44_000,
  },
  {
    id: "orbital",
    name: "Orbital relay",
    blurb: "Satellites passing packets over the horizon.",
    baseCost: 5_100_000_000,
    rate: 260_000,
  },
  {
    id: "grid",
    name: "Planetary grid",
    blurb: "Every cable, tower and toaster, integrated.",
    baseCost: 75_000_000_000,
    rate: 1_600_000,
  },
];

/** Each unit of a tier costs this much more than the last. */
export const COST_GROWTH = 1.15;

export type UpgradeEffect =
  /** Production of one tier ×factor. */
  | { kind: "tier"; tier: number; factor: number }
  /** Records per click ×factor. */
  | { kind: "click"; factor: number }
  /** Each click also earns this share of a second's production. */
  | { kind: "clickShare"; share: number }
  /** Tier `tier` gets +pct % production per unit of tier `from` owned. */
  | { kind: "synergy"; tier: number; from: number; pct: number }
  /** The soft ending. */
  | { kind: "ending" };

export type Requirement =
  | { kind: "owned"; tier: number; count: number }
  | { kind: "clicks"; count: number }
  | { kind: "lifetime"; records: number }
  | { kind: "all"; of: readonly Requirement[] };

export interface Upgrade {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly cost: number;
  readonly requires: Requirement;
  readonly effect: UpgradeEffect;
}

/** Ownership milestones for each tier's ×2 upgrades, and their cost as a multiple of the tier's base cost. */
const TIER_MILESTONES = [
  { count: 1, costFactor: 10 },
  { count: 10, costFactor: 50 },
  { count: 25, costFactor: 500 },
  { count: 50, costFactor: 50_000 },
] as const;

const TIER_UPGRADE_NAMES: readonly (readonly [string, string][])[] = [
  [
    ["Intern gets coffee", "Caffeine is a dependency."],
    ["Second monitor", "Source on the left, target on the right."],
    ["Keyboard shortcuts", "The mouse was the bottleneck."],
    ["Ctrl+C, Ctrl+V certified", "Officially a professional now."],
  ],
  [
    ["Fixed the timezone", "Jobs now run when you think they run."],
    ["*/1 * * * *", "Every minute, not every month."],
    ["Retries on failure", "Try again. And again."],
    ["Someone reads the logs", "Turns out they were full of warnings."],
  ],
  [
    ["Passive mode", "Through the firewall at last."],
    ["PGP keys exchanged", "Encrypted, signed, and only slightly expired."],
    ["Folder naming convention", "IN, OUT, ARCHIVE, and no more FINAL_v2."],
    ["Nobody renames mid-transfer", "Partial files are a thing of the past."],
  ],
  [
    ["Pagination handled", "Page 2 exists, it turns out."],
    ["OAuth refresh tokens", "No more 401s at midnight."],
    ["Rate limits respected", "Fewer 429s, more 200s."],
    ["Docs match reality", "A first for the industry."],
  ],
  [
    ["Dead-letter queue", "Poison messages go somewhere to think."],
    ["Idempotent consumers", "Twice is the same as once."],
    ["Exactly-once (allegedly)", "Marketing said so."],
    ["Backpressure", "The queue says no, politely."],
  ],
  [
    ["Incremental loads", "Only what changed since yesterday."],
    ["Parallel workers", "Eight cores, all busy."],
    ["Schema drift detection", "Someone added a column. You noticed."],
    ["Done before standup", "The nightly job finishes at night."],
  ],
  [
    ["Partitioned by date", "Queries stop scanning the whole lake."],
    ["Columnar storage", "Reads only the columns it needs."],
    ["It's a lakehouse now", "Same lake, better branding."],
    ["Someone found the data", "It was in the lake all along."],
  ],
  [
    ["Failover tested", "On purpose, this time."],
    ["Latency-aware routing", "Packets take the scenic route less often."],
    ["Active-active", "Both regions, all the time."],
    ["Survived us-east-1", "The outage came. You stayed up."],
  ],
  [
    ["Laser uplinks", "Light is fast. Lasers are light."],
    ["Solar sails", "Free thrust, courtesy of the sun."],
    ["Orbital caching", "Hot data stays in low orbit."],
    ["Low Earth latency", "Ping times that make fibre jealous."],
  ],
  [
    ["Continental backbone", "One pipe per continent."],
    ["Ocean-floor fibre", "Whales are now part of the topology."],
    ["Tectonic load balancing", "Sharded by plate boundary."],
    ["Every toaster is a node", "Breakfast is now distributed."],
  ],
];

function tierUpgrades(): Upgrade[] {
  return GENERATORS.flatMap((generator, tier) =>
    TIER_MILESTONES.map(({ count, costFactor }, level) => {
      const [name, blurb] = TIER_UPGRADE_NAMES[tier]?.[level] ?? [
        `${generator.name} ${level + 1}`,
        "",
      ];
      return {
        id: `${generator.id}-${level + 1}`,
        name,
        blurb: `${blurb} ${generator.name} production ×2.`,
        cost: generator.baseCost * costFactor,
        requires: { kind: "owned", tier, count },
        effect: { kind: "tier", tier, factor: 2 },
      } satisfies Upgrade;
    }),
  );
}

const CLICK_UPGRADES: Upgrade[] = [
  {
    id: "click-1",
    name: "Mechanical keyboard",
    blurb: "Satisfying. Loud. Records per click ×2.",
    cost: 100,
    requires: { kind: "clicks", count: 50 },
    effect: { kind: "click", factor: 2 },
  },
  {
    id: "click-2",
    name: "Macros",
    blurb: "One key, many records. Records per click ×2.",
    cost: 1_000,
    requires: { kind: "clicks", count: 250 },
    effect: { kind: "click", factor: 2 },
  },
  {
    id: "click-3",
    name: "Batch mode",
    blurb: "Each click also earns 1 % of a second's production.",
    cost: 50_000,
    requires: { kind: "clicks", count: 1_000 },
    effect: { kind: "clickShare", share: 0.01 },
  },
  {
    id: "click-4",
    name: "Bulk API",
    blurb: "Each click also earns another 2 % of a second's production.",
    cost: 5_000_000,
    requires: { kind: "clicks", count: 2_500 },
    effect: { kind: "clickShare", share: 0.02 },
  },
  {
    id: "click-5",
    name: "Streaming",
    blurb: "Each click also earns another 3 % of a second's production.",
    cost: 500_000_000,
    requires: { kind: "clicks", count: 5_000 },
    effect: { kind: "clickShare", share: 0.03 },
  },
];

const SYNERGIES: Upgrade[] = [
  {
    id: "syn-scheduled-transfers",
    name: "Scheduled transfers",
    blurb: "Cron jobs kick off the pulls. SFTP +1 % per cron job.",
    cost: 500_000,
    requires: {
      kind: "all",
      of: [
        { kind: "owned", tier: 1, count: 15 },
        { kind: "owned", tier: 2, count: 15 },
      ],
    },
    effect: { kind: "synergy", tier: 2, from: 1, pct: 1 },
  },
  {
    id: "syn-webhooks",
    name: "Webhooks into queues",
    blurb: "Connectors publish instead of polling. Queues +1 % per REST connector.",
    cost: 50_000_000,
    requires: {
      kind: "all",
      of: [
        { kind: "owned", tier: 3, count: 15 },
        { kind: "owned", tier: 4, count: 15 },
      ],
    },
    effect: { kind: "synergy", tier: 4, from: 3, pct: 1 },
  },
  {
    id: "syn-lake-etl",
    name: "ETL reads the lake",
    blurb: "One copy of the truth. ETL +1 % per data lake.",
    cost: 5_000_000_000,
    requires: {
      kind: "all",
      of: [
        { kind: "owned", tier: 5, count: 15 },
        { kind: "owned", tier: 6, count: 15 },
      ],
    },
    effect: { kind: "synergy", tier: 5, from: 6, pct: 1 },
  },
  {
    id: "syn-orbital-peering",
    name: "Orbital peering",
    blurb: "The mesh routes through space. Orbital relays +1 % per mesh region.",
    cost: 500_000_000_000,
    requires: {
      kind: "all",
      of: [
        { kind: "owned", tier: 7, count: 15 },
        { kind: "owned", tier: 8, count: 15 },
      ],
    },
    effect: { kind: "synergy", tier: 8, from: 7, pct: 1 },
  },
];

/** The id of the upgrade that ends the game. */
export const ENDING_UPGRADE = "integrate-earth";

const ENDING: Upgrade = {
  id: ENDING_UPGRADE,
  name: "Integrate Earth",
  blurb: "Connect the last system on the planet. There is nothing left to integrate. Is there?",
  cost: 1e15,
  requires: { kind: "owned", tier: 9, count: 10 },
  effect: { kind: "ending" },
};

export const UPGRADES: readonly Upgrade[] = [
  ...tierUpgrades(),
  ...CLICK_UPGRADES,
  ...SYNERGIES,
  ENDING,
];

export const UPGRADES_BY_ID: ReadonlyMap<string, Upgrade> = new Map(UPGRADES.map((u) => [u.id, u]));

/** What an achievement checks, against the state after every step. */
export type AchievementTest =
  | { kind: "lifetime"; records: number }
  | { kind: "owned"; tier: number; count: number }
  | { kind: "totalOwned"; count: number }
  | { kind: "clicks"; count: number }
  | { kind: "golden"; count: number }
  | { kind: "migrations"; count: number }
  | { kind: "upgrades"; count: number }
  | { kind: "rate"; perSecond: number }
  | { kind: "ended" }
  | { kind: "linked" };

export interface Achievement {
  readonly id: string;
  readonly name: string;
  readonly blurb: string;
  readonly test: AchievementTest;
}

/** Each achievement is a permanent +1 % production. */
export const ACHIEVEMENT_BONUS = 0.01;

export const ACHIEVEMENTS: readonly Achievement[] = [
  {
    id: "hello-world",
    name: "Hello World",
    blurb: "Process your first record.",
    test: { kind: "lifetime", records: 1 },
  },
  {
    id: "kilo",
    name: "Spreadsheet scale",
    blurb: "Process 1,000 records.",
    test: { kind: "lifetime", records: 1e3 },
  },
  {
    id: "mega",
    name: "Database scale",
    blurb: "Process a million records.",
    test: { kind: "lifetime", records: 1e6 },
  },
  {
    id: "giga",
    name: "Big data",
    blurb: "Process a billion records.",
    test: { kind: "lifetime", records: 1e9 },
  },
  {
    id: "tera",
    name: "Bigger data",
    blurb: "Process a trillion records.",
    test: { kind: "lifetime", records: 1e12 },
  },
  {
    id: "peta",
    name: "Biggest data",
    blurb: "Process a quadrillion records.",
    test: { kind: "lifetime", records: 1e15 },
  },
  {
    id: "exa",
    name: "Data gravity",
    blurb: "Process a quintillion records.",
    test: { kind: "lifetime", records: 1e18 },
  },
  {
    id: "intern-army",
    name: "Intern army",
    blurb: "Own 100 interns.",
    test: { kind: "owned", tier: 0, count: 100 },
  },
  {
    id: "planet-scale",
    name: "Planet scale",
    blurb: "Own a planetary grid.",
    test: { kind: "owned", tier: 9, count: 1 },
  },
  {
    id: "infra-100",
    name: "Infrastructure",
    blurb: "Own 100 generators.",
    test: { kind: "totalOwned", count: 100 },
  },
  {
    id: "infra-250",
    name: "Sprawl",
    blurb: "Own 250 generators.",
    test: { kind: "totalOwned", count: 250 },
  },
  {
    id: "infra-500",
    name: "Nobody knows what half of these do",
    blurb: "Own 500 generators.",
    test: { kind: "totalOwned", count: 500 },
  },
  {
    id: "clicks-100",
    name: "Hands-on",
    blurb: "Click 100 times.",
    test: { kind: "clicks", count: 100 },
  },
  {
    id: "clicks-1000",
    name: "Carpal tunnel",
    blurb: "Click 1,000 times.",
    test: { kind: "clicks", count: 1_000 },
  },
  {
    id: "clicks-10000",
    name: "ClickOps",
    blurb: "Click 10,000 times.",
    test: { kind: "clicks", count: 10_000 },
  },
  {
    id: "golden-1",
    name: "Lucky packet",
    blurb: "Catch a golden packet.",
    test: { kind: "golden", count: 1 },
  },
  {
    id: "golden-10",
    name: "Packet sniffer",
    blurb: "Catch 10 golden packets.",
    test: { kind: "golden", count: 10 },
  },
  {
    id: "golden-50",
    name: "Golden pipeline",
    blurb: "Catch 50 golden packets.",
    test: { kind: "golden", count: 50 },
  },
  {
    id: "migrate-1",
    name: "Lift and shift",
    blurb: "Complete a platform migration.",
    test: { kind: "migrations", count: 1 },
  },
  {
    id: "migrate-3",
    name: "Never Again",
    blurb: "Complete your third migration.",
    test: { kind: "migrations", count: 3 },
  },
  {
    id: "migrate-5",
    name: "Migration fatigue",
    blurb: "Complete five migrations.",
    test: { kind: "migrations", count: 5 },
  },
  {
    id: "migrate-10",
    name: "Serial migrator",
    blurb: "Complete ten migrations.",
    test: { kind: "migrations", count: 10 },
  },
  {
    id: "upgrades-10",
    name: "Refactored",
    blurb: "Own 10 upgrades at once.",
    test: { kind: "upgrades", count: 10 },
  },
  {
    id: "upgrades-25",
    name: "Re-architected",
    blurb: "Own 25 upgrades at once.",
    test: { kind: "upgrades", count: 25 },
  },
  {
    id: "upgrades-40",
    name: "Rewritten in Rust",
    blurb: "Own 40 upgrades at once.",
    test: { kind: "upgrades", count: 40 },
  },
  {
    id: "rate-1k",
    name: "Throughput",
    blurb: "Reach 1,000 records per second.",
    test: { kind: "rate", perSecond: 1e3 },
  },
  {
    id: "rate-1m",
    name: "High throughput",
    blurb: "Reach a million records per second.",
    test: { kind: "rate", perSecond: 1e6 },
  },
  {
    id: "rate-1b",
    name: "Firehose",
    blurb: "Reach a billion records per second.",
    test: { kind: "rate", perSecond: 1e9 },
  },
  { id: "the-end", name: "Hello, World", blurb: "Integrate Earth.", test: { kind: "ended" } },
  {
    id: "works-on-my-machine",
    name: "Works On My Machine",
    blurb: "Link a second device (try the CLI).",
    test: { kind: "linked" },
  },
];
