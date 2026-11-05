#!/usr/bin/env node
/**
 * Animated GitHub contribution snake.
 *
 * - Reads the contribution calendar through the GitHub GraphQL API (Octokit).
 * - Renders two self-contained, animated SVGs (light + dark) with SMIL + CSS.
 * - Publishes them to the `output` branch through the Git Data API (Octokit).
 *
 * Local preview (no token needed, uses deterministic mock data):
 *   SNAKE_OUTPUT_DIR=./preview node generate.mjs
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Octokit } from "octokit";

/* -------------------------------------------------------------------------- */
/* Layout                                                                     */
/* -------------------------------------------------------------------------- */

const CELL = 10;
const GAP = 3;
const PITCH = CELL + GAP;
const ROWS = 7;
const MARGIN = { top: 36, right: 16, bottom: 16, left: 48 };

const SNAKE_SPEED = 260; // px per second
const BEAD_COUNT = 18; // snake body segments
const BEAD_DELAY = 0.026; // seconds between body segments
const SNAKE_PATH_ID = "snake-path";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const THEMES = {
  light: {
    label: "#57606a",
    empty: "#ebedf0",
    levels: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    snake: ["#0ea5e9", "#3b82f6", "#6366f1"],
    eye: "#ffffff",
    title: "GitHub contribution snake (light)",
  },
  dark: {
    label: "#8b949e",
    empty: "#161b22",
    levels: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
    snake: ["#a5f3fc", "#38bdf8", "#818cf8"],
    eye: "#0b1220",
    title: "GitHub contribution snake (dark)",
  },
};

/* -------------------------------------------------------------------------- */
/* Small helpers                                                              */
/* -------------------------------------------------------------------------- */

const fmt = (value) => String(Number(value.toFixed(2)));
const key = (col, row) => `${col}:${row}`;

function levelFor(count) {
  if (count <= 0) return 0;
  if (count < 4) return 1;
  if (count < 7) return 2;
  if (count < 10) return 3;
  return 4;
}

function hexToRgb(hex) {
  const value = hex.replace("#", "");
  return [0, 2, 4].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
}

function rgbToHex(rgb) {
  return `#${rgb.map((channel) => Math.round(channel).toString(16).padStart(2, "0")).join("")}`;
}

function mixColors(from, to, t) {
  const a = hexToRgb(from);
  const b = hexToRgb(to);
  return rgbToHex(a.map((channel, index) => channel + (b[index] - channel) * t));
}

/** Sample a multi-stop color ramp, t in [0, 1]. */
function sampleColor(stops, t) {
  const clamped = Math.min(Math.max(t, 0), 1);
  const position = clamped * (stops.length - 1);
  const index = Math.min(Math.floor(position), stops.length - 2);
  return mixColors(stops[index], stops[index + 1], position - index);
}

/* -------------------------------------------------------------------------- */
/* Data                                                                       */
/* -------------------------------------------------------------------------- */

/** Turns the API weeks into columns of 7 cells (row = weekday). */
function normalizeWeeks(rawWeeks) {
  return rawWeeks
    .map((week) => {
      const column = Array.from({ length: ROWS }, () => null);
      for (const day of week.contributionDays ?? []) {
        const row = Number(day.weekday);
        if (row >= 0 && row < ROWS) {
          column[row] = { date: day.date, count: Number(day.contributionCount) || 0 };
        }
      }
      return column;
    })
    .filter((column) => column.some(Boolean));
}

async function fetchContributions(octokit, login) {
  const to = new Date();
  const from = new Date(to.getTime() - 364 * 24 * 60 * 60 * 1000);

  const query = `
    query ($login: String!, $from: DateTime!, $to: DateTime!) {
      user(login: $login) {
        contributionsCollection(from: $from, to: $to) {
          contributionCalendar {
            weeks {
              contributionDays {
                date
                contributionCount
                weekday
              }
            }
          }
        }
      }
    }
  `;

  const result = await octokit.graphql(query, {
    login,
    from: from.toISOString(),
    to: to.toISOString(),
  });

  const weeks = result?.user?.contributionsCollection?.contributionCalendar?.weeks;
  if (!Array.isArray(weeks) || weeks.length === 0) {
    throw new Error(`No contribution calendar returned for "${login}"`);
  }

  return normalizeWeeks(weeks);
}

/* -------------------------------------------------------------------------- */
/* SVG                                                                        */
/* -------------------------------------------------------------------------- */

function buildSvg(themeName, weeks) {
  const theme = THEMES[themeName];
  const cols = weeks.length;
  if (cols === 0) throw new Error("Cannot render a snake without contribution weeks");

  const gridWidth = cols * PITCH - GAP;
  const gridHeight = ROWS * PITCH - GAP;
  const width = MARGIN.left + gridWidth + MARGIN.right;
  const height = MARGIN.top + gridHeight + MARGIN.bottom;

  const cellX = (col) => MARGIN.left + col * PITCH;
  const cellY = (row) => MARGIN.top + row * PITCH;
  const centerX = (col) => cellX(col) + CELL / 2;
  const centerY = (row) => cellY(row) + CELL / 2;

  /* Serpentine route: top -> bottom, bottom -> top, ... */
  const route = [];
  const rowsDown = Array.from({ length: ROWS }, (_, index) => index);
  for (let col = 0; col < cols; col += 1) {
    const rows = col % 2 === 0 ? rowsDown : [...rowsDown].reverse();
    for (const row of rows) route.push({ col, row });
  }

  /* Distance (and therefore arrival time) of every cell along the route. */
  const distanceTo = new Map();
  let snakeLength = 0;
  distanceTo.set(key(route[0].col, route[0].row), 0);
  for (let index = 1; index < route.length; index += 1) {
    const previous = route[index - 1];
    const current = route[index];
    snakeLength += Math.hypot(
      centerX(current.col) - centerX(previous.col),
      centerY(current.row) - centerY(previous.row),
    );
    distanceTo.set(key(current.col, current.row), snakeLength);
  }

  const firstCell = route[0];
  const lastCell = route[route.length - 1];
  const startX = centerX(firstCell.col);
  const startY = centerY(firstCell.row);
  const endX = centerX(lastCell.col);
  const endY = centerY(lastCell.row);

  /* Loop back around the outside of the grid so the motion is seamless. */
  const routeBottom = MARGIN.top + gridHeight + 8;
  const routeTop = 10;
  const routeLeft = 10;
  const descentX = MARGIN.left - 6;
  const returnPoints = [
    [endX, endY],
    [endX, routeBottom],
    [routeLeft, routeBottom],
    [routeLeft, routeTop],
    [descentX, routeTop],
    [descentX, startY],
    [startX, startY],
  ];

  let returnLength = 0;
  for (let index = 1; index < returnPoints.length; index += 1) {
    returnLength += Math.hypot(
      returnPoints[index][0] - returnPoints[index - 1][0],
      returnPoints[index][1] - returnPoints[index - 1][1],
    );
  }

  const totalLength = snakeLength + returnLength;
  const duration = totalLength / SNAKE_SPEED;

  let path = `M ${fmt(startX)} ${fmt(startY)}`;
  for (let index = 1; index < route.length; index += 1) {
    path += ` L ${fmt(centerX(route[index].col))} ${fmt(centerY(route[index].row))}`;
  }
  for (let index = 1; index < returnPoints.length; index += 1) {
    path += ` L ${fmt(returnPoints[index][0])} ${fmt(returnPoints[index][1])}`;
  }

  /* Cells */
  const baseCells = [];
  const eatenCells = [];
  for (let col = 0; col < cols; col += 1) {
    for (let row = 0; row < ROWS; row += 1) {
      const x = fmt(cellX(col));
      const y = fmt(cellY(row));
      baseCells.push(
        `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${theme.empty}"/>`,
      );

      const day = weeks[col][row];
      if (!day || day.count <= 0) continue;

      const level = levelFor(day.count);
      const delay = (distanceTo.get(key(col, row)) / totalLength) * duration;
      eatenCells.push(
        `<rect class="e" x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" ` +
          `fill="${theme.levels[level]}" style="animation-delay:${delay.toFixed(2)}s"/>`,
      );
    }
  }

  /* Month labels */
  const labels = [];
  let lastMonth = -1;
  let lastLabelX = Number.NEGATIVE_INFINITY;
  for (let col = 0; col < cols; col += 1) {
    const day = weeks[col].find(Boolean);
    if (!day) continue;

    const month = new Date(`${day.date}T00:00:00Z`).getUTCMonth();
    if (month === lastMonth) continue;

    const x = cellX(col);
    if (x - lastLabelX >= 30 && x + 26 <= width - MARGIN.right) {
      labels.push(`<text x="${fmt(x)}" y="${MARGIN.top - 14}">${MONTHS[month]}</text>`);
      lastLabelX = x;
    }
    lastMonth = month;
  }

  /* Weekday labels */
  const weekdays = [];
  if (cols >= 12) {
    for (const [row, label] of [
      [1, "Mon"],
      [3, "Wed"],
      [5, "Fri"],
    ]) {
      weekdays.push(
        `<text x="${MARGIN.left - 8}" y="${fmt(centerY(row) + 3.2)}" text-anchor="end">${label}</text>`,
      );
    }
  }

  /* Snake body: each bead follows the same path with a small time offset. */
  const beads = [];
  for (let index = BEAD_COUNT - 1; index >= 0; index -= 1) {
    const color = sampleColor(theme.snake, index / (BEAD_COUNT - 1));
    const begin = (-duration + index * BEAD_DELAY).toFixed(3);
    const motion =
      `<animateMotion dur="${duration.toFixed(3)}s" begin="${begin}s" ` +
      `repeatCount="indefinite" rotate="auto">` +
      `<mpath xlink:href="#${SNAKE_PATH_ID}"/></animateMotion>`;

    if (index === 0) {
      beads.push(
        `<g>${motion}` +
          `<rect x="-9" y="-4.6" width="14" height="9.2" rx="4.6" fill="${color}"/>` +
          `<circle cx="2.4" cy="-1.9" r="1.15" fill="${theme.eye}"/>` +
          `<circle cx="2.4" cy="1.9" r="1.15" fill="${theme.eye}"/>` +
          `</g>`,
      );
    } else {
      const beadWidth = Math.max(4, 11 - index * 0.42);
      const beadHeight = Math.max(3.2, 8.4 - index * 0.34);
      beads.push(
        `<rect x="${fmt(-beadWidth / 2)}" y="${fmt(-beadHeight / 2)}" ` +
          `width="${fmt(beadWidth)}" height="${fmt(beadHeight)}" rx="${fmt(beadHeight / 2)}" ` +
          `fill="${color}">${motion}</rect>`,
      );
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="snake-title snake-desc">
<title id="snake-title">${theme.title}</title>
<desc id="snake-desc">An animated snake travelling through a GitHub contribution graph and eating the contribution squares.</desc>
<style>
  .e { animation: snake-eat ${duration.toFixed(2)}s linear infinite; }
  @keyframes snake-eat {
    0%, 2% { opacity: 1; }
    7%, 96% { opacity: 0; }
    100% { opacity: 1; }
  }
  text {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    font-size: 9.5px;
    font-weight: 500;
    letter-spacing: 0.02em;
  }
</style>
<defs>
  <filter id="snake-glow" x="-70%" y="-70%" width="240%" height="240%">
    <feGaussianBlur stdDeviation="2" result="blur"/>
    <feMerge>
      <feMergeNode in="blur"/>
      <feMergeNode in="SourceGraphic"/>
    </feMerge>
  </filter>
</defs>
<g fill="${theme.label}">
${labels.join("\n")}
${weekdays.join("\n")}
</g>
<g>
${baseCells.join("\n")}
</g>
<g>
${eatenCells.join("\n")}
</g>
<path id="${SNAKE_PATH_ID}" d="${path}" fill="none" stroke="none"/>
<g filter="url(#snake-glow)">
${beads.join("\n")}
</g>
</svg>
`;
}

/* -------------------------------------------------------------------------- */
/* Publishing (Octokit)                                                       */
/* -------------------------------------------------------------------------- */

function repoCoordinates() {
  const [owner, repo] = (process.env.GITHUB_REPOSITORY ?? "").split("/");
  if (!owner || !repo) throw new Error("GITHUB_REPOSITORY is not set (expected owner/repo)");
  return { owner, repo, login: process.env.GITHUB_REPOSITORY_OWNER || owner };
}

async function readPublishedFile(octokit, owner, repo, path) {
  try {
    const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref: "output" });
    if (Array.isArray(data) || data.type !== "file" || data.encoding !== "base64") return null;
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch (error) {
    if (error.status === 404) return null;
    throw error;
  }
}

async function publish(files) {
  const { owner, repo } = repoCoordinates();
  const octokit = new Octokit({ auth: process.env.GITHUB_TOKEN, userAgent: "contribution-snake" });

  let changed = false;
  for (const file of files) {
    const current = await readPublishedFile(octokit, owner, repo, file.name);
    if (current !== file.content) changed = true;
  }

  if (!changed) {
    console.log("Snake is already up to date - nothing to publish.");
    return;
  }

  let headSha = null;
  try {
    const { data } = await octokit.rest.git.getRef({ owner, repo, ref: "heads/output" });
    headSha = data.object.sha;
  } catch (error) {
    if (error.status !== 404) throw error;
  }

  if (!headSha) {
    const { data: repository } = await octokit.rest.repos.get({ owner, repo });
    const { data } = await octokit.rest.git.getRef({
      owner,
      repo,
      ref: `heads/${repository.default_branch}`,
    });
    headSha = data.object.sha;
  }

  const { data: parent } = await octokit.rest.git.getCommit({ owner, repo, commit_sha: headSha });

  const blobs = await Promise.all(
    files.map((file) =>
      octokit.rest.git.createBlob({ owner, repo, content: file.content, encoding: "utf-8" }),
    ),
  );

  const { data: tree } = await octokit.rest.git.createTree({
    owner,
    repo,
    base_tree: parent.tree.sha,
    tree: files.map((file, index) => ({
      path: file.name,
      mode: "100644",
      type: "blob",
      sha: blobs[index].data.sha,
    })),
  });

  const { data: commit } = await octokit.rest.git.createCommit({
    owner,
    repo,
    message: "chore: update animated contribution snake",
    tree: tree.sha,
    parents: [headSha],
  });

  try {
    await octokit.rest.git.updateRef({ owner, repo, ref: "heads/output", sha: commit.sha });
  } catch (error) {
    if (error.status === 404) {
      await octokit.rest.git.createRef({ owner, repo, ref: "refs/heads/output", sha: commit.sha });
    } else if (error.status === 422) {
      await octokit.rest.git.updateRef({ owner, repo, ref: "heads/output", sha: commit.sha, force: true });
    } else {
      throw error;
    }
  }

  console.log(`Published ${files.map((file) => file.name).join(", ")} to output@${commit.sha.slice(0, 7)}`);
}

/* -------------------------------------------------------------------------- */
/* Local preview                                                              */
/* -------------------------------------------------------------------------- */

function mockWeeks() {
  const today = new Date();
  const weeks = [];

  for (let col = 0; col < 53; col += 1) {
    const column = Array.from({ length: ROWS }, () => null);
    for (let row = 0; row < ROWS; row += 1) {
      const date = new Date(today);
      date.setUTCDate(today.getUTCDate() - ((52 - col) * 7 + (6 - row)));
      const wave = 6 + 7 * Math.sin(col * 0.7 + row * 0.9);
      const weekend = row === 0 || row === 6 ? 0.35 : 1;
      column[row] = {
        date: date.toISOString().slice(0, 10),
        count: Math.max(0, Math.round(wave * weekend)),
      };
    }
    weeks.push(column);
  }

  return weeks;
}

/* -------------------------------------------------------------------------- */
/* Entry point                                                                */
/* -------------------------------------------------------------------------- */

async function main() {
  const localDir = process.env.SNAKE_OUTPUT_DIR;
  let weeks;

  if (localDir) {
    weeks = mockWeeks();
    console.log(`Local preview mode: rendering ${weeks.length} weeks of mock data.`);
  } else {
    const { login } = repoCoordinates();
    const octokit = new Octokit({
      auth: process.env.GITHUB_TOKEN,
      userAgent: "contribution-snake",
    });
    weeks = await fetchContributions(octokit, login);
    console.log(`Fetched ${weeks.length} weeks of contributions for ${login}.`);
  }

  const files = [
    { name: "github-contribution-grid-snake.svg", content: buildSvg("light", weeks) },
    { name: "github-contribution-grid-snake-dark.svg", content: buildSvg("dark", weeks) },
  ];

  if (localDir) {
    await mkdir(localDir, { recursive: true });
    for (const file of files) {
      await writeFile(join(localDir, file.name), file.content, "utf8");
    }
    console.log(`Wrote ${files.map((file) => file.name).join(", ")} to ${localDir}`);
    return;
  }

  await publish(files);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
