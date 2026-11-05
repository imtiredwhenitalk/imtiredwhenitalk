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
const MARGIN = { top: 128, right: 16, bottom: 16, left: 48 };

const SNAKE_SPEED = 110; // px per second
const BEAD_COUNT = 18; // snake body segments
const BEAD_DELAY = 0.05; // seconds between body segments
const SNAKE_PATH_ID = "snake-path";
const OCTO_SIZE = 108;
const OCTO_BODY_PATH =
  "M50 4 C72 4 90 21 90 45 C90 66 74 82 50 82 C26 82 10 66 10 45 C10 21 28 4 50 4 Z";

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const THEMES = {
  light: {
    label: "#57606a",
    empty: "#ebedf0",
    levels: ["#ebedf0", "#9be9a8", "#40c463", "#30a14e", "#216e39"],
    snake: ["#0ea5e9", "#3b82f6", "#6366f1"],
    eye: "#ffffff",
    accent: "#0284c7",
    panel: { fill: "#f6f8fa", stroke: "#d0d7de" },
    octo: {
      body: ["#ddd6fe", "#8b5cf6", "#5b21b6"],
      tentacle: ["#a78bfa", "#6d28d9"],
      eye: "#ffffff",
      iris: "#0891b2",
      pupil: "#1e1b4b",
      mouth: "#4c1d95",
      blush: "#f472b6",
      halo: "#8b5cf6",
      shadow: "#4c1d95",
    },
    title: "GitHub contribution snake (light)",
  },
  dark: {
    label: "#8b949e",
    empty: "#161b22",
    levels: ["#161b22", "#0e4429", "#006d32", "#26a641", "#39d353"],
    snake: ["#a5f3fc", "#38bdf8", "#818cf8"],
    eye: "#0b1220",
    accent: "#38bdf8",
    panel: { fill: "#161b22", stroke: "#30363d" },
    octo: {
      body: ["#c4b5fd", "#8b5cf6", "#4c1d95"],
      tentacle: ["#a78bfa", "#5b21b6"],
      eye: "#ffffff",
      iris: "#22d3ee",
      pupil: "#140b2e",
      mouth: "#3b0764",
      blush: "#f472b6",
      halo: "#8b5cf6",
      shadow: "#000000",
    },
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
/* Octopus mascot                                                             */
/* -------------------------------------------------------------------------- */

function buildOctopus(theme, x, y) {
  const o = theme.octo;

  const tentacle = (d, px, py, amplitude, dur, opacity) => {
    const values = `${-amplitude} ${px} ${py};${amplitude} ${px} ${py};${-amplitude} ${px} ${py}`;
    return `<path d="${d}" fill="none" stroke="url(#octo-tentacle)" stroke-width="10" stroke-linecap="round" opacity="${opacity}">
      <animateTransform attributeName="transform" type="rotate" values="${values}" keyTimes="0;0.5;1" dur="${dur}s" repeatCount="indefinite" calcMode="spline" keySplines="0.42 0 0.58 1;0.42 0 0.58 1"/>
    </path>`;
  };

  const eye = (cx) => `<g transform="translate(${cx} 45)">
    <g>
      <animateTransform attributeName="transform" type="scale" values="1 1;1 1;1 0.08;1 1" keyTimes="0;0.93;0.965;1" dur="6.4s" repeatCount="indefinite"/>
      <ellipse rx="11.5" ry="12.5" fill="${o.eye}"/>
      <g>
        <animateTransform attributeName="transform" type="translate" values="-2.5 0.6;2.5 0.6;-2.5 0.6" keyTimes="0;0.5;1" dur="9s" repeatCount="indefinite" calcMode="spline" keySplines="0.45 0 0.55 1;0.45 0 0.55 1"/>
        <circle cx="-1.5" cy="2.5" r="6" fill="${o.iris}"/>
        <circle cx="-1.5" cy="2.5" r="3.2" fill="${o.pupil}"/>
        <circle cx="-3.2" cy="0.6" r="1.8" fill="#ffffff" opacity="0.9"/>
      </g>
    </g>
  </g>`;

  return `<g transform="translate(${fmt(x)} ${fmt(y)})" aria-hidden="true">
  <ellipse cx="50" cy="48" rx="52" ry="50" fill="url(#octo-halo)"/>
  <ellipse cx="50" cy="98" rx="30" ry="4.5" fill="${o.shadow}" opacity="0.25"/>
  <g>
    <animateTransform attributeName="transform" type="translate" values="0 0;0 -2.2;0 0" keyTimes="0;0.5;1" dur="5s" repeatCount="indefinite" calcMode="spline" keySplines="0.4 0 0.6 1;0.4 0 0.6 1"/>
    ${tentacle("M22 68 C15 71 8 74 5 82", 22, 68, 5, 7, 0.7)}
    ${tentacle("M78 68 C85 71 92 74 95 82", 78, 68, -5, 7.4, 0.7)}
    ${tentacle("M30 72 C22 78 13 82 10 90 C8 96 14 99 19 94", 30, 72, 4, 6.2, 0.9)}
    ${tentacle("M70 72 C78 78 87 82 90 90 C92 96 86 99 81 94", 70, 72, -4, 6.6, 0.9)}
    ${tentacle("M41 80 C36 87 29 91 27 98 C26 103 32 104 35 99", 41, 80, 3.5, 5.4, 1)}
    ${tentacle("M59 80 C64 87 71 91 73 98 C74 103 68 104 65 99", 59, 80, -3.5, 5.8, 1)}
    ${tentacle("M50 82 C49 89 45 93 45 99 C45 103 50 104 52 100", 50, 82, 3, 4.8, 1)}
    <path d="${OCTO_BODY_PATH}" fill="url(#octo-body)"/>
    <g clip-path="url(#octo-body-clip)">
      <ellipse cx="50" cy="88" rx="44" ry="20" fill="${o.body[2]}" opacity="0.5"/>
    </g>
    <path d="M68 10 C81 16 89 29 90 43" fill="none" stroke="${o.body[0]}" stroke-width="2" stroke-linecap="round" opacity="0.55"/>
    <ellipse cx="33" cy="22" rx="14" ry="9" fill="url(#octo-shine)" transform="rotate(-28 33 22)"/>
    <ellipse cx="43" cy="13" rx="5.5" ry="3.5" fill="#ffffff" opacity="0.35" transform="rotate(-28 43 13)"/>
    ${eye(35)}
    ${eye(65)}
    <ellipse cx="22" cy="57" rx="5" ry="3" fill="${o.blush}" opacity="0.35"/>
    <ellipse cx="78" cy="57" rx="5" ry="3" fill="${o.blush}" opacity="0.35"/>
    <path d="M45 60 Q50 66 55 60" fill="none" stroke="${o.mouth}" stroke-width="2.2" stroke-linecap="round"/>
  </g>
</g>`;
}

/* -------------------------------------------------------------------------- */
/* Score panel                                                                */
/* -------------------------------------------------------------------------- */

function buildScorePanel(theme, x, y, duration, keyTimes, scores, total) {
  const digitHeight = 30;
  const places = Math.max(3, String(total).length);
  const slot = (place) => 14 + (places - 1 - place) * 20;
  const centers = Array.from({ length: places }, (_, place) => slot(place) + 10);
  const clipX = Array.from({ length: places }, (_, place) => slot(place));
  const totalX = 14 + places * 20 + 14;
  const panelWidth = 168 + (places - 3) * 20;
  const keyTimesAttr =
    keyTimes.length > 1 ? ` keyTimes="${keyTimes.map((t) => t.toFixed(6)).join(";")}"` : "";

  const defs = clipX
    .map(
      (cx, index) =>
        `<clipPath id="score-clip-${index}"><rect x="${cx}" y="27" width="20" height="30"/></clipPath>`,
    )
    .join("\n");

  const digits = Array.from({ length: places }, (_, place) => {
    const values = scores
      .map((score) => `0 ${-((Math.floor(score / 10 ** place) % 10) * digitHeight)}`)
      .join(";");
    const strip = Array.from(
      { length: 10 },
      (_, digit) =>
        `<text x="${centers[place]}" y="${50 + digit * digitHeight}" text-anchor="middle" style="font-size:26px;font-weight:700">${digit}</text>`,
    ).join("");
    return `<g clip-path="url(#score-clip-${place})"><g><animateTransform attributeName="transform" type="translate" values="${values}"${keyTimesAttr} calcMode="discrete" dur="${duration.toFixed(3)}s" repeatCount="indefinite"/>${strip}</g></g>`;
  }).join("\n");

  const markup = `<g transform="translate(${fmt(x)} ${fmt(y)})">
  <rect x="0" y="0" width="${panelWidth}" height="58" rx="14" fill="${theme.panel.fill}" stroke="${theme.panel.stroke}"/>
  <text x="14" y="19" fill="${theme.label}" style="font-size:7.5px;letter-spacing:0.14em">COMMITS EATEN</text>
  <g fill="${theme.accent}">
${digits}
  </g>
  <text x="${totalX}" y="49" fill="${theme.label}" style="font-size:11px">of ${total}</text>
</g>`;

  return { defs, markup };
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

  /* Score: one point per eaten contribution. */
  const scored = [];
  for (const cell of route) {
    const day = weeks[cell.col][cell.row];
    if (day && day.count > 0) scored.push(distanceTo.get(key(cell.col, cell.row)) / totalLength);
  }
  const scoreEvents = scored.map((t, index) => ({ t, score: index + 1 }));
  let initialScore = 0;
  if (scoreEvents.length > 0 && scoreEvents[0].t < 0.001) {
    initialScore = scoreEvents[0].score;
    scoreEvents.shift();
  }
  const scoreKeyTimes = [0, ...scoreEvents.map((event) => event.t)];
  const scoreValues = [initialScore, ...scoreEvents.map((event) => event.score)];

  /* Month labels sit just below the octopus. */
  const octoX = width - MARGIN.right - OCTO_SIZE;
  const octoY = 0;
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

  /* Giant octopus watching the worm, plus the score panel. */
  const octopus = buildOctopus(theme, octoX, octoY);
  const scorePanel = buildScorePanel(
    theme,
    MARGIN.left,
    21,
    duration,
    scoreKeyTimes,
    scoreValues,
    scored.length,
  );

  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-labelledby="snake-title snake-desc">
<title id="snake-title">${theme.title}</title>
<desc id="snake-desc">A slow animated worm travelling through a GitHub contribution graph and eating the contribution squares, one point per commit, while a giant 3D octopus watches from above.</desc>
<style>
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
  <radialGradient id="octo-body" cx="38%" cy="26%" r="78%">
    <stop offset="0%" stop-color="${theme.octo.body[0]}"/>
    <stop offset="52%" stop-color="${theme.octo.body[1]}"/>
    <stop offset="100%" stop-color="${theme.octo.body[2]}"/>
  </radialGradient>
  <linearGradient id="octo-tentacle" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0%" stop-color="${theme.octo.tentacle[0]}"/>
    <stop offset="100%" stop-color="${theme.octo.tentacle[1]}"/>
  </linearGradient>
  <radialGradient id="octo-halo" cx="50%" cy="50%" r="50%">
    <stop offset="0%" stop-color="${theme.octo.halo}" stop-opacity="0.28"/>
    <stop offset="62%" stop-color="${theme.octo.halo}" stop-opacity="0.1"/>
    <stop offset="100%" stop-color="${theme.octo.halo}" stop-opacity="0"/>
  </radialGradient>
  <linearGradient id="octo-shine" x1="0" y1="0" x2="0.4" y2="1">
    <stop offset="0%" stop-color="#ffffff" stop-opacity="0.55"/>
    <stop offset="100%" stop-color="#ffffff" stop-opacity="0"/>
  </linearGradient>
  <clipPath id="octo-body-clip">
    <path d="${OCTO_BODY_PATH}"/>
  </clipPath>
${scorePanel.defs}
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
${octopus}
${scorePanel.markup}
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
