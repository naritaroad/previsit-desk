//! The patient-education handbook: parsing, validation and in-process lexical retrieval (no external API).
//!
//! File format (`data/rag/health_education.zh-TW.md`): chapters `##`, sections `### §N.M Title`, and right under
//! each section title one blockquote line
//! `> source_type=official|authority|project; source_name=...; source_url=https://...; verified_on=YYYY-MM-DD`.
//! A section is the unit; long sections are cut at paragraph boundaries and every part keeps the metadata.

use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::sync::LazyLock;

use anyhow::{Context, Result, bail};
use regex::Regex;
use serde::Serialize;
use time::Date;

use crate::clock::parse_date;

const CHUNK_TARGET_CHARS: usize = 500;
const HIT_TEXT_CHARS: usize = 600;
pub const MAX_TOP_K: usize = 3;
/// A hit must cover this share of the query's known, weighted terms.
const MIN_COVERAGE: f32 = 0.30;
/// Matched weight, in units where a term found in one chunk only is 1.0: two matched terms must reach the first
/// value, one rare term alone the second.
const MIN_MASS: f32 = 0.6;
const MIN_SINGLE_MASS: f32 = 0.8;
const TITLE_WEIGHT: f32 = 3.0;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SourceType {
    Official,
    Authority,
    Project,
}

impl SourceType {
    fn parse(value: &str) -> Option<Self> {
        match value.trim() {
            "official" => Some(Self::Official),
            "authority" => Some(Self::Authority),
            "project" => Some(Self::Project),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Official => "official",
            Self::Authority => "authority",
            Self::Project => "project",
        }
    }
}

#[derive(Debug, Clone)]
pub struct Chunk {
    pub section: String,
    pub title: String,
    pub text: String,
    pub source_type: SourceType,
    pub source_name: String,
    pub source_url: Option<String>,
    pub verified_on: Date,
}

#[derive(Debug, Clone, Serialize)]
pub struct Hit {
    pub section: String,
    pub title: String,
    pub text: String,
    pub source_type: SourceType,
    pub source_name: String,
    pub source_url: Option<String>,
    pub verified_on: String,
    pub score: f32,
}

#[derive(Debug, Clone)]
struct Synonym {
    term: String,
    expansions: Vec<String>,
}

pub struct Handbook {
    chunks: Vec<Chunk>,
    tf: Vec<HashMap<String, f32>>,
    df: HashMap<String, usize>,
    synonyms: Vec<Synonym>,
}

static META_KEY: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(source_type|source_name|source_url|verified_on)=").expect("regex")
});
static SECTION_HEADING: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^§?\s*(\d+(?:\.\d+)*)\s+(.+)$").expect("regex"));

struct Meta {
    source_type: SourceType,
    source_name: String,
    source_url: Option<String>,
    verified_on: Date,
}

fn parse_meta(line: &str, section: &str) -> Result<Meta> {
    let body = line.trim_start_matches('>').trim();
    let marks: Vec<(usize, usize, &str)> = META_KEY
        .captures_iter(body)
        .map(|c| {
            (
                c.get(0).expect("match").start(),
                c.get(0).expect("match").end(),
                c.get(1).expect("key").as_str(),
            )
        })
        .collect();
    let mut values: HashMap<&str, String> = HashMap::new();
    for (i, (_, value_start, key)) in marks.iter().enumerate() {
        let end = marks.get(i + 1).map_or(body.len(), |next| next.0);
        values.insert(
            key,
            body[*value_start..end]
                .trim()
                .trim_end_matches(';')
                .trim()
                .to_string(),
        );
    }
    let source_type = values
        .get("source_type")
        .and_then(|v| SourceType::parse(v))
        .with_context(|| {
            format!("{section}: source_type must be official, authority or project")
        })?;
    let source_name = values.get("source_name").cloned().unwrap_or_default();
    if source_name.is_empty() {
        bail!("{section}: source_name is missing");
    }
    let source_url = values.get("source_url").cloned().filter(|u| !u.is_empty());
    match (&source_url, source_type) {
        (Some(url), _) if !url.starts_with("https://") => {
            bail!("{section}: source_url must start with https://")
        }
        (None, SourceType::Official | SourceType::Authority) => bail!(
            "{section}: source_url is required for {}",
            source_type.as_str()
        ),
        _ => {}
    }
    let verified_on = values
        .get("verified_on")
        .and_then(|v| parse_date(v))
        .with_context(|| format!("{section}: verified_on must be YYYY-MM-DD"))?;
    Ok(Meta {
        source_type,
        source_name,
        source_url,
        verified_on,
    })
}

/// Cuts a section body at paragraph boundaries into parts of roughly `CHUNK_TARGET_CHARS`.
fn split_body(body: &str) -> Vec<String> {
    let mut parts: Vec<String> = Vec::new();
    let mut current = String::new();
    let push_piece = |piece: &str, current: &mut String, parts: &mut Vec<String>| {
        if !current.is_empty()
            && current.chars().count() + piece.chars().count() > CHUNK_TARGET_CHARS
        {
            parts.push(std::mem::take(current));
        }
        if !current.is_empty() {
            current.push('\n');
        }
        current.push_str(piece);
    };
    for paragraph in body.split("\n\n").map(str::trim).filter(|p| !p.is_empty()) {
        if paragraph.chars().count() > HIT_TEXT_CHARS {
            // One huge paragraph: cut at sentence ends.
            let mut sentence = String::new();
            for c in paragraph.chars() {
                sentence.push(c);
                if matches!(c, '。' | '！' | '？') && sentence.chars().count() >= 40 {
                    push_piece(&sentence, &mut current, &mut parts);
                    sentence.clear();
                }
            }
            if !sentence.is_empty() {
                push_piece(&sentence, &mut current, &mut parts);
            }
        } else {
            push_piece(paragraph, &mut current, &mut parts);
        }
    }
    if !current.is_empty() {
        parts.push(current);
    }
    parts
}

fn is_cjk(c: char) -> bool {
    ('\u{4e00}'..='\u{9fff}').contains(&c)
}

/// CJK unigrams and bigrams plus lowercase ASCII words (length 2 or more).
fn index_tokens(text: &str) -> Vec<String> {
    let mut tokens = Vec::new();
    let chars: Vec<char> = text.to_lowercase().chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if is_cjk(chars[i]) {
            let start = i;
            while i < chars.len() && is_cjk(chars[i]) {
                i += 1;
            }
            let run = &chars[start..i];
            for c in run {
                tokens.push(c.to_string());
            }
            for pair in run.windows(2) {
                tokens.push(pair.iter().collect());
            }
        } else if chars[i].is_ascii_alphanumeric() {
            let start = i;
            while i < chars.len() && chars[i].is_ascii_alphanumeric() {
                i += 1;
            }
            if i - start >= 2 {
                tokens.push(chars[start..i].iter().collect());
            }
        } else {
            i += 1;
        }
    }
    tokens
}

/// Words that say nothing about the topic. Longer phrases first so they are removed whole.
const STOP_PHRASES: &[&str] = &[
    "怎麼辦",
    "為什麼",
    "什麼時候",
    "是不是",
    "有沒有",
    "要不要",
    "想知道",
    "請問",
    "一下",
    "什麼",
    "怎麼",
    "如何",
    "需要",
    "應該",
    "可以",
    "還是",
    "一直",
    "有點",
    "真的",
    "比較",
    "可能",
    "大概",
    "今天",
    "明天",
    "昨天",
    "現在",
    "最近",
    "一段",
    "一個",
    "一些",
    "我",
    "你",
    "您",
    "他",
    "她",
    "的",
    "了",
    "嗎",
    "呢",
    "吧",
    "啊",
    "是",
    "有",
    "要",
    "去",
    "會",
    "也",
    "都",
    "就",
    "還",
    "很",
    "在",
    "和",
    "跟",
    "與",
    "及",
    "或",
    "但",
    "請",
    "想",
    "讓",
    "給",
    "被",
    "把",
    "這",
    "那",
    "個",
    "些",
    "人",
    "幾",
    "多",
    "能",
    "該",
];

impl Handbook {
    /// An empty handbook (no file): every search finds nothing.
    pub fn empty() -> Self {
        Self {
            chunks: Vec::new(),
            tf: Vec::new(),
            df: HashMap::new(),
            synonyms: Vec::new(),
        }
    }

    pub fn load(handbook_path: &Path, synonyms_path: &Path) -> Result<Self> {
        let markdown = std::fs::read_to_string(handbook_path)
            .with_context(|| format!("read {}", handbook_path.display()))?;
        let synonyms_csv = match std::fs::read_to_string(synonyms_path) {
            Ok(text) => text,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => String::new(),
            Err(e) => return Err(e).with_context(|| format!("read {}", synonyms_path.display())),
        };
        Self::parse(&markdown, &synonyms_csv)
            .with_context(|| format!("check {}", handbook_path.display()))
    }

    pub fn parse(markdown: &str, synonyms_csv: &str) -> Result<Self> {
        let markdown = markdown
            .trim_start_matches('\u{feff}')
            .replace("\r\n", "\n");
        let mut chunks = Vec::new();
        let mut seen_sections = HashSet::new();
        let mut lines = markdown.lines().peekable();
        let mut chapter = String::new();
        while let Some(line) = lines.next() {
            if let Some(title) = line.strip_prefix("## ") {
                chapter = title.trim().to_string();
            } else if let Some(heading) = line.strip_prefix("### ") {
                let heading = heading.trim();
                let caps = SECTION_HEADING.captures(heading).with_context(|| {
                    format!("section heading needs a number like \"§1.1 Title\": {heading}")
                })?;
                let section = format!("§{}", &caps[1]);
                let title = caps[2].trim().to_string();
                if !seen_sections.insert(section.clone()) {
                    bail!("section {section} appears twice");
                }
                while lines.peek().is_some_and(|l| l.trim().is_empty()) {
                    lines.next();
                }
                let meta_line = lines.peek().filter(|l| l.trim_start().starts_with('>')).copied().with_context(|| format!("{section} {title}: the line under the title must be the source blockquote"))?;
                lines.next();
                let meta = parse_meta(meta_line, &section)?;
                let mut body = String::new();
                while let Some(next) = lines.peek() {
                    if next.starts_with("## ") || next.starts_with("### ") || next.starts_with("# ")
                    {
                        break;
                    }
                    body.push_str(next);
                    body.push('\n');
                    lines.next();
                }
                let parts = split_body(&body);
                if parts.is_empty() {
                    bail!("{section} {title}: the section has no text");
                }
                let _ = &chapter;
                for text in parts {
                    chunks.push(Chunk {
                        section: section.clone(),
                        title: title.clone(),
                        text,
                        source_type: meta.source_type,
                        source_name: meta.source_name.clone(),
                        source_url: meta.source_url.clone(),
                        verified_on: meta.verified_on,
                    });
                }
            }
        }
        if chunks.is_empty() {
            bail!("no sections found");
        }
        let mut tf = Vec::with_capacity(chunks.len());
        let mut df: HashMap<String, usize> = HashMap::new();
        for chunk in &chunks {
            let mut counts: HashMap<String, f32> = HashMap::new();
            for token in index_tokens(&chunk.text) {
                *counts.entry(token).or_insert(0.0) += 1.0;
            }
            for token in index_tokens(&chunk.title) {
                *counts.entry(token).or_insert(0.0) += TITLE_WEIGHT;
            }
            for token in counts.keys() {
                *df.entry(token.clone()).or_insert(0) += 1;
            }
            tf.push(counts);
        }
        Ok(Self {
            chunks,
            tf,
            df,
            synonyms: parse_synonyms(synonyms_csv)?,
        })
    }

    pub fn section_count(&self) -> usize {
        self.chunks
            .iter()
            .map(|c| c.section.as_str())
            .collect::<HashSet<_>>()
            .len()
    }

    pub fn chunk_count(&self) -> usize {
        self.chunks.len()
    }

    pub fn synonym_count(&self) -> usize {
        self.synonyms.len()
    }

    /// Inverse document frequency scaled so a term found in a single chunk is 1.0, whatever the handbook size.
    fn idf(&self, token: &str) -> f32 {
        let n = self.chunks.len() as f32;
        let df = self.df.get(token).copied().unwrap_or(0) as f32;
        let raw = (1.0 + (n - df + 0.5) / (df + 0.5)).ln();
        let rarest = (1.0 + (n - 1.0 + 0.5) / 1.5).ln();
        if rarest <= 0.0 { 0.0 } else { raw / rarest }
    }

    /// Query tokens with weights: topic terms 1.0, single leftover characters 0.5, synonym expansions 0.5.
    fn query_terms(&self, query: &str) -> Vec<(String, f32)> {
        let lowered = query.to_lowercase();
        let mut stripped = lowered.clone();
        for phrase in STOP_PHRASES {
            stripped = stripped.replace(phrase, " ");
        }
        let mut weights: HashMap<String, f32> = HashMap::new();
        let mut add = |token: String, weight: f32| {
            let entry = weights.entry(token).or_insert(0.0);
            *entry = entry.max(weight);
        };
        let chars: Vec<char> = stripped.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if is_cjk(chars[i]) {
                let start = i;
                while i < chars.len() && is_cjk(chars[i]) {
                    i += 1;
                }
                let run = &chars[start..i];
                if run.len() == 1 {
                    add(run[0].to_string(), 0.5);
                }
                for pair in run.windows(2) {
                    add(pair.iter().collect(), 1.0);
                }
            } else if chars[i].is_ascii_alphanumeric() {
                let start = i;
                while i < chars.len() && chars[i].is_ascii_alphanumeric() {
                    i += 1;
                }
                if i - start >= 2 {
                    add(chars[start..i].iter().collect(), 1.0);
                }
            } else {
                i += 1;
            }
        }
        for synonym in &self.synonyms {
            if lowered.contains(&synonym.term) {
                for expansion in &synonym.expansions {
                    for token in index_tokens(expansion)
                        .into_iter()
                        .filter(|t| t.chars().count() >= 2)
                    {
                        add(token, 0.5);
                    }
                }
            }
        }
        weights.into_iter().collect()
    }

    /// Up to `top_k` (at most 3) best sections for `query`; empty when nothing covers enough of the question.
    pub fn search(&self, query: &str, top_k: usize) -> Vec<Hit> {
        let top_k = top_k.clamp(1, MAX_TOP_K);
        let terms = self.query_terms(query);
        if terms.is_empty() || self.chunks.is_empty() {
            return Vec::new();
        }
        // Words the handbook never uses say nothing about which section fits, so they do not count against coverage.
        let known: Vec<&(String, f32)> = terms
            .iter()
            .filter(|(t, _)| self.df.contains_key(t))
            .collect();
        let total: f32 = known.iter().map(|(t, w)| w * self.idf(t)).sum();
        if known.is_empty() || total <= 0.0 {
            return Vec::new();
        }
        let mut scored: Vec<(usize, f32)> = Vec::new();
        for (index, counts) in self.tf.iter().enumerate() {
            let (mut mass, mut score, mut matched_terms) = (0.0f32, 0.0f32, 0);
            for (token, weight) in &known {
                if let Some(tf) = counts.get(token) {
                    let idf = self.idf(token);
                    mass += weight * idf;
                    score += weight * idf * (tf / (tf + 1.2));
                    matched_terms += 1;
                }
            }
            let strong = (matched_terms >= 2 && mass >= MIN_MASS) || mass >= MIN_SINGLE_MASS;
            if strong && mass / total >= MIN_COVERAGE {
                scored.push((index, score));
            }
        }
        scored.sort_by(|a, b| b.1.total_cmp(&a.1));
        let mut seen = HashSet::new();
        let mut hits = Vec::new();
        for (index, score) in scored {
            let chunk = &self.chunks[index];
            if !seen.insert(chunk.section.clone()) {
                continue;
            }
            hits.push(Hit {
                section: chunk.section.clone(),
                title: chunk.title.clone(),
                text: chunk.text.chars().take(HIT_TEXT_CHARS).collect(),
                source_type: chunk.source_type,
                source_name: chunk.source_name.clone(),
                source_url: chunk.source_url.clone(),
                verified_on: crate::clock::format_date(chunk.verified_on),
                score: (score * 100.0).round() / 100.0,
            });
            if hits.len() == top_k {
                break;
            }
        }
        hits
    }
}

fn parse_synonyms(csv_text: &str) -> Result<Vec<Synonym>> {
    if csv_text.trim().is_empty() {
        return Ok(Vec::new());
    }
    let mut reader =
        csv::ReaderBuilder::new().from_reader(csv_text.trim_start_matches('\u{feff}').as_bytes());
    let headers = reader.headers()?.clone();
    let term_col = headers
        .iter()
        .position(|h| h.trim() == "term")
        .context("synonyms.csv: missing column term")?;
    let exp_col = headers
        .iter()
        .position(|h| h.trim() == "expansions")
        .context("synonyms.csv: missing column expansions")?;
    let mut out = Vec::new();
    for row in reader.records() {
        let row = row?;
        let term = row.get(term_col).unwrap_or("").trim().to_lowercase();
        if term.is_empty() {
            continue;
        }
        let expansions: Vec<String> = row
            .get(exp_col)
            .unwrap_or("")
            .split(';')
            .map(|e| e.trim().to_lowercase())
            .filter(|e| !e.is_empty())
            .collect();
        out.push(Synonym { term, expansions });
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = include_str!("../tests/fixtures/health_edu_sample.md");
    const SYNONYMS: &str = "term,expansions\n發熱,發燒;體溫\n領藥,慢箋;調劑\n";

    fn sample() -> Handbook {
        Handbook::parse(SAMPLE, SYNONYMS).expect("sample handbook")
    }

    #[test]
    fn parses_sections_with_metadata() {
        let h = sample();
        assert_eq!(h.section_count(), 4);
        let hit = &h.search("發燒三天要不要看醫生", 3)[0];
        assert_eq!(hit.section, "§1.1");
        assert_eq!(hit.title, "發燒何時就醫");
        assert_eq!(hit.source_type, SourceType::Official);
        assert_eq!(
            hit.source_url.as_deref(),
            Some("https://example.gov.tw/fever")
        );
        assert_eq!(hit.verified_on, "2026-11-20");
        assert!(hit.text.contains("急診"));
    }

    #[test]
    fn retrieval_finds_the_known_section_for_known_questions() {
        let h = sample();
        for (query, section) in [
            ("發燒三天了什麼時候要去急診", "§1.1"),
            ("咳嗽好幾週了要不要看醫師", "§1.2"),
            ("慢箋怎麼領藥", "§2.1"),
            ("慢性病連續處方箋領藥要帶什麼", "§2.1"),
            ("預問診會問什麼", "§2.2"),
            ("咳血", "§1.2"),
        ] {
            let hits = h.search(query, 3);
            assert_eq!(
                hits.first().map(|x| x.section.as_str()),
                Some(section),
                "{query}: {hits:?}"
            );
        }
    }

    #[test]
    fn synonyms_bridge_wording() {
        let h = sample();
        assert_eq!(h.search("發熱什麼時候要就醫", 1)[0].section, "§1.1");
    }

    #[test]
    fn out_of_scope_questions_find_nothing() {
        let h = sample();
        for query in [
            "今天天氣如何",
            "幫我寫一段 python 程式",
            "台北有什麼好吃的",
            "",
            "？？？",
        ] {
            assert!(h.search(query, 3).is_empty(), "{query}");
        }
    }

    #[test]
    fn top_k_is_capped_at_three_and_sections_are_unique() {
        let h = sample();
        let hits = h.search("發燒 咳嗽 慢箋 預問診 醫師", 10);
        assert!(hits.len() <= 3);
        let sections: HashSet<_> = hits.iter().map(|x| x.section.clone()).collect();
        assert_eq!(sections.len(), hits.len());
        assert_eq!(h.search("發燒", 1).len(), 1);
    }

    #[test]
    fn hit_text_is_capped_and_long_sections_are_split_with_metadata() {
        let long_para = "這是一段很長的衛教說明，用來測試切段。".repeat(40);
        let md = format!(
            "## 章\n\n### §9.1 長的一節\n> source_type=official; source_name=範例; source_url=https://example.gov.tw/x; verified_on=2026-11-25\n\n{long_para}\n\n第二段也有一些內容。\n"
        );
        let h = Handbook::parse(&md, "").expect("parse");
        assert!(h.chunk_count() > 1);
        for hit in h.search("衛教說明切段", 3) {
            assert!(hit.text.chars().count() <= HIT_TEXT_CHARS);
            assert_eq!(hit.source_url.as_deref(), Some("https://example.gov.tw/x"));
        }
    }

    #[test]
    fn project_sections_may_have_no_url_but_official_ones_may_not() {
        assert!(Handbook::parse(SAMPLE, "").is_ok());
        let missing_url = SAMPLE.replace("source_url=https://example.gov.tw/fever", "source_url=");
        assert!(Handbook::parse(&missing_url, "").is_err());
        let http = SAMPLE.replace(
            "https://example.gov.tw/fever",
            "http://example.gov.tw/fever",
        );
        assert!(Handbook::parse(&http, "").is_err());
    }

    #[test]
    fn invalid_metadata_refuses_to_load() {
        assert!(
            Handbook::parse(
                &SAMPLE.replace(
                    "source_type=official; source_name=範例機關〈發燒處理〉",
                    "source_type=blog; source_name=範例機關〈發燒處理〉"
                ),
                ""
            )
            .is_err()
        );
        assert!(
            Handbook::parse(
                &SAMPLE.replace("verified_on=2026-11-20", "verified_on=2026-13-40"),
                ""
            )
            .is_err()
        );
        assert!(
            Handbook::parse(
                &SAMPLE.replace("verified_on=2026-11-20", "verified_on="),
                ""
            )
            .is_err()
        );
        assert!(Handbook::parse(&SAMPLE.replace("> source_type=official; source_name=範例機關〈發燒處理〉; source_url=https://example.gov.tw/fever; verified_on=2026-11-20\n", ""), "").is_err(), "missing blockquote");
        assert!(Handbook::parse("# nothing here\n", "").is_err());
        assert!(Handbook::parse("### 沒有編號\n> source_type=project; source_name=x; source_url=; verified_on=2026-11-25\n\n文字\n", "").is_err());
    }

    #[test]
    fn duplicate_section_numbers_are_rejected() {
        let dup = format!(
            "{SAMPLE}\n### §1.1 重複\n> source_type=project; source_name=x; source_url=; verified_on=2026-11-25\n\n文字文字\n"
        );
        assert!(Handbook::parse(&dup, "").is_err());
    }

    #[test]
    fn source_names_with_semicolons_do_not_break_the_metadata_line() {
        let md = "### §1.1 標題\n> source_type=official; source_name=甲機關；乙機關; source_url=https://example.gov.tw/a; verified_on=2026-11-25\n\n內容內容內容\n";
        let h = Handbook::parse(md, "").expect("parse");
        let hit = &h.search("內容", 1)[0];
        assert_eq!(hit.source_name, "甲機關；乙機關");
    }

    #[test]
    fn the_real_handbook_loads_and_answers_basic_questions_when_present() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("..")
            .join("data");
        let path = root.join("rag").join("health_education.zh-TW.md");
        if !path.exists() {
            return;
        }
        let h =
            Handbook::load(&path, &root.join("seed").join("synonyms.csv")).expect("real handbook");
        assert!(h.section_count() >= 10);
        for query in [
            "發燒什麼時候要看醫生",
            "慢箋怎麼領藥",
            "胸痛要不要叫救護車",
            "我想自殺怎麼辦",
        ] {
            assert!(
                !h.search(query, 3).is_empty(),
                "{query} should find a section"
            );
        }
        for query in ["今天天氣如何", "幫我寫一段 python 程式"] {
            assert!(h.search(query, 3).is_empty(), "{query} should find nothing");
        }
    }
}
