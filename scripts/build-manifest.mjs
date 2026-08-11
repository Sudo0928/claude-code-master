#!/usr/bin/env node
/**
 * 강의 HTML을 스캔해서 메인 페이지가 읽어들일 목록(lectures.json)을 만든다.
 *
 * - 외부 의존성 없음 (Node 18+)
 * - 스캔 대상: 저장소 루트의 *.html + lectures/ 하위의 *.html
 * - 제외 대상: index.html, 404.html, _ 로 시작하는 파일
 *
 * 새 강의 HTML을 폴더에 넣고 push 하기만 하면 GitHub Actions가 이 스크립트를
 * 실행해 목록을 다시 만들기 때문에, 메인 페이지에 자동으로 나타난다.
 *
 * 사용법: node scripts/build-manifest.mjs
 */

import { readFileSync, writeFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = fileURLToPath(new URL('..', import.meta.url));
const OUTPUT_FILE = join(rootDir, 'lectures.json');
const ORDER_FILE = join(rootDir, 'lectures.order.txt');

// 강의가 아닌 페이지들 (목록에 넣지 않는다)
const EXCLUDED = new Set(['index.html', '404.html']);
// 루트 외에 추가로 훑을 하위 폴더
const EXTRA_DIRS = ['lectures'];

/* ---------------------------------------------------------------- 유틸 */

/** HTML 엔티티를 실제 문자로 되돌린다 */
function decodeEntities(text) {
  const named = {
    nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
    middot: '·', hellip: '…', mdash: '—', ndash: '–', times: '×', rsquo: '’',
  };
  return text
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (whole, name) => named[name.toLowerCase()] ?? whole);
}

/** 태그를 걷어내고 공백을 정리한 순수 텍스트만 남긴다 */
function toPlainText(html) {
  if (!html) return '';
  return decodeEntities(html.replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

/** 정규식의 첫 번째 캡처 그룹을 반환 (없으면 빈 문자열) */
function firstMatch(source, regex) {
  const found = source.match(regex);
  return found ? found[1] : '';
}

/* ------------------------------------------------------- 파일 수집/파싱 */

/** 스캔 대상 HTML 파일 경로를 모은다 (저장소 루트 기준 상대 경로) */
function collectHtmlFiles() {
  const files = [];

  for (const entry of readdirSync(rootDir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.html')) {
      if (EXCLUDED.has(entry.name) || entry.name.startsWith('_')) continue;
      files.push(entry.name);
    }
  }

  for (const dirName of EXTRA_DIRS) {
    const dirPath = join(rootDir, dirName);
    if (!existsSync(dirPath)) continue;
    walk(dirPath);
  }

  function walk(dirPath) {
    for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
      const fullPath = join(dirPath, entry.name);
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.name.endsWith('.html') && !entry.name.startsWith('_')) {
        files.push(relative(rootDir, fullPath).split(sep).join('/'));
      }
    }
  }

  return files;
}

/**
 * 부제 한 줄을 설명 / 출처 / 날짜로 쪼갠다.
 * 예) "터미널이 처음이어도 괜찮습니다 · 공식 문서 기반 · 2026.07"
 *     → { description: "터미널이 처음이어도 괜찮습니다", source: "공식 문서 기반", date: "2026.07" }
 */
function splitSubtitle(subtitle) {
  const parts = subtitle.split(/\s*·\s*/).map((part) => part.trim()).filter(Boolean);
  let date = '';
  let source = '';

  if (parts.length && /^\d{4}[.\-/]\d{1,2}$/.test(parts[parts.length - 1])) {
    date = parts.pop().replace(/[-/]/g, '.');
  }
  if (parts.length > 1 && /기반|출처|참고|기준/.test(parts[parts.length - 1])) {
    source = parts.pop();
  }

  return { description: parts.join(' · '), source, date };
}

/** 파일이 마지막으로 바뀐 시각 — git 기록을 우선하고, 없으면 파일 수정 시각을 쓴다 */
function lastUpdated(relativePath) {
  try {
    const isoDate = execFileSync(
      'git',
      ['log', '-1', '--format=%cI', '--', relativePath],
      { cwd: rootDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    if (isoDate) return isoDate;
  } catch {
    // git 저장소가 아니거나 아직 커밋되지 않은 파일 → 아래 fallback 사용
  }
  return statSync(join(rootDir, relativePath)).mtime.toISOString();
}

/** HTML 한 개에서 카드에 필요한 정보를 뽑아낸다 */
function parseLecture(relativePath) {
  const html = readFileSync(join(rootDir, relativePath), 'utf8');

  const title =
    toPlainText(firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i)) ||
    relativePath.replace(/\.html$/, '');

  // 커버 슬라이드 우측 상단의 "#시작하기" 같은 태그
  const rawTag = toPlainText(firstMatch(html, /<div class="tag"[^>]*>([\s\S]*?)<\/div>/i));
  const tags = rawTag.split(/\s+/).filter(Boolean).map((tag) => tag.replace(/^#/, ''));

  // 커버 슬라이드 하단의 한 줄 부제
  const subtitle = toPlainText(firstMatch(html, /<div class="sub"[^>]*>([\s\S]*?)<\/div>/i));
  const { description, source, date } = splitSubtitle(subtitle);

  // 시리즈명 (브랜드 영역의 <b>클로드 코드 완벽 마스터</b>)
  const series = toPlainText(firstMatch(html, /<div class="brand"[^>]*>[\s\S]*?<b>([\s\S]*?)<\/b>/i));

  // 슬라이드 장수 — <section class="slide"> 개수를 센다
  const slides = (html.match(/<section[^>]*class="[^"]*\bslide\b[^"]*"/gi) || []).length;

  return {
    file: relativePath,
    title,
    tags,
    description,
    source,
    date,
    series,
    slides,
    bytes: statSync(join(rootDir, relativePath)).size,
    updated: lastUpdated(relativePath),
  };
}

/* -------------------------------------------------------------- 정렬 */

/**
 * lectures.order.txt에 적힌 순서를 먼저 따르고,
 * 거기 없는 파일은 최근에 바뀐 것부터 뒤에 이어 붙인다.
 * (순서 파일이 없어도 그냥 동작한다)
 */
function sortLectures(lectures) {
  let orderedNames = [];
  if (existsSync(ORDER_FILE)) {
    orderedNames = readFileSync(ORDER_FILE, 'utf8')
      .split(/\r?\n/)
      .map((line) => line.replace(/#.*$/, '').trim())
      .filter(Boolean);
  }

  const rankOf = (file) => {
    const index = orderedNames.indexOf(file);
    return index === -1 ? Number.MAX_SAFE_INTEGER : index;
  };

  return lectures.sort((a, b) => {
    const rankDiff = rankOf(a.file) - rankOf(b.file);
    if (rankDiff !== 0) return rankDiff;
    // 순서 파일에 없는 것끼리는 최신 수정순
    return b.updated.localeCompare(a.updated);
  });
}

/* --------------------------------------------------------------- 실행 */

const lectures = sortLectures(collectHtmlFiles().map(parseLecture));
lectures.forEach((lecture, index) => {
  lecture.order = index + 1;
});

const manifest = {
  generatedAt: new Date().toISOString(),
  series: lectures.find((lecture) => lecture.series)?.series || '수업 자료',
  count: lectures.length,
  totalSlides: lectures.reduce((sum, lecture) => sum + lecture.slides, 0),
  lectures,
};

writeFileSync(OUTPUT_FILE, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

console.log(`lectures.json 생성 완료 — 강의 ${manifest.count}개 / 슬라이드 ${manifest.totalSlides}장`);
for (const lecture of lectures) {
  console.log(`  ${String(lecture.order).padStart(2, '0')}. ${lecture.title}  (${lecture.slides}장, ${lecture.file})`);
}
