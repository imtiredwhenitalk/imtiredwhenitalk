#!/usr/bin/env node
/**
 * Animated GitHub contribution snake.
 *
 * - Reads the contribution calendar through the GitHub GraphQL API (Octokit).
 * - Renders two self-contained, animated SVGs (light + dark) with SMIL.
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
const MARGIN = { top: 116, right: 16, bottom: 16, left: 48 };

const SNAKE_SPEED = 110; // px per second
const BEAD_COUNT = 18; // snake body segments
const BEAD_DELAY = 0.05; // seconds between body segments
const SNAKE_PATH_ID = "snake-path";
const OCTOCAT_SIZE = 88;
/* GitHub's official mark-github octicon (16x16 Octocat silhouette). */
const OCTOCAT_PATH =
  "M6.766 11.328c-2.063-.25-3.516-1.734-3.516-3.656 0-.781.281-1.625.75-2.188-.203-.515-.172-1.609.063-2.062.625-.078 1.468.25 1.968.703.594-.187 1.219-.281 1.985-.281.765 0 1.39.094 1.953.265.484-.437 1.344-.765 1.969-.687.218.422.25 1.515.046 2.047.5.593.766 1.39.766 2.203 0 1.922-1.453 3.375-3.547 3.64.531.344.89 1.094.89 1.954v1.625c0 .468.391.734.86.547C13.781 14.359 16 11.53 16 8.03 16 3.61 12.406 0 7.984 0 3.563 0 0 3.61 0 8.031a7.88 7.88 0 0 0 5.172 7.422c.422.156.828-.125.828-.547v-1.25c-.219.094-.5.156-.75.156-1.031 0-1.64-.562-2.078-1.609-.172-.422-.36-.672-.719-.719-.187-.015-.25-.093-.25-.187 0-.188.313-.328.625-.328.453 0 .844.281 1.25.86.313.452.64.655 1.031.655s.641-.14 1-.5c.266-.265.47-.5.657-.656";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const THEMES = {
  light: {
    label: "#57606a",
    empty: "#ebedf0",
    levels: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    snake: ["#0969da", "#0550ae"],
    eye: "#ffffff",
    octocat: "#1f2328",
    title: "GitHub contribution snake (light)",
  },
  dark: {
    label: "#8b949e",
    empty: "#161b22",
    levels: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
    snake: ["#58a6ff", "#1f6feb"],
    eye: "#0b1220",
    octocat: "#e6edf3",
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
/* Octocat                                                                    */
/* -------------------------------------------------------------------------- */

function buildOctocat(theme, x, y) {
  return `<g transform="translate(${fmt(x)} ${fmt(y)})" aria-hidden="true">
  <g>
    <animateTransform attributeName="transform" type="translate" values="0 0;0 -3;0 0" keyTimes="0;0.5;1" dur="5.5s" repeatCount="indefinite" calcMode="spline" keySplines="0.42 0 0.58 1;0.42 0 0.58 1"/>
    <g>
      <animateTransform attributeName="transform" type="rotate" values="-1.2 44 44;1.2 44 44;-1.2 44 44" keyTimes="0;0.5;1" dur="9s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/>
      <g transform="scale(${fmt(OCTOCAT_SIZE / 16)})">
        <path d="${OCTOCAT_PATH}" fill="${theme.octocat}"/>
      </g>
    </g>
  </g>
</g>`;
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
  const descentX = MARGIN.left - 10;
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

  /* Cells: each contribution disappears when the worm reaches it, then all
     cells reappear together once the worm is back at the start. */
  const cellFade = 0.55 / duration;
  const eatLead = 0.2 / duration;
  const resetAt = 0.99;
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
      const t = distanceTo.get(key(col, row)) / totalLength;
      const start = Math.max(0.0008, t - eatLead);
      const end = Math.min(resetAt - 0.005, start + cellFade);
      eatenCells.push(
        `<rect x="${x}" y="${y}" width="${CELL}" height="${CELL}" rx="2" fill="${theme.levels[level]}">` +
          `<animate attributeName="opacity" dur="${duration.toFixed(3)}s" repeatCount="indefinite" ` +
          `values="1;1;0;0;1" keyTimes="0;${start.toFixed(5)};${end.toFixed(5)};${resetAt};1"/>` +
          `</rect>`,
      );
    }
  }

  /* Month labels sit just below the Octocat. */
  const octoX = width - MARGIN.right - OCTOCAT_SIZE;
  const octoY = 4;
  const labelRightLimit = width - MARGIN.right;
  const labels = [];
  let lastMonth = -1;
  let lastLabelX = Number.NEGATIVE_INFINITY;
  for (let col = 0; col < cols; col += 1) {
    const day = weeks[col].find(Boolean);
    if (!day) continue;

    const month = new Date(`${day.date}T00:00:00Z`).getUTCMonth();
    if (month === lastMonth) continue;

    const x = cellX(col);
    if (x - lastLabelX >= 30 && x + 26 <= labelRightLimit) {
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

  /* GitHub Octocat watching the worm. */
  const octocat = buildOctocat(theme, octoX, octoY);

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="snake-title snake-desc">
<title id="snake-title">${theme.title}</title>
<desc id="snake-desc">A slow animated worm travelling through a GitHub contribution graph and eating the contribution squares, while the GitHub Octocat watches from above.</desc>
<style>
  text {
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace;
    font-size: 9.5px;
    font-weight: 500;
    letter-spacing: 0.02em;
  }
</style>
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
<g>
${beads.join("\n")}
</g>
${octocat}
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
