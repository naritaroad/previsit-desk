//! The drug list (`data/seed/formulary.csv`): which medicines may be requested online, which need an individual
//! physician look, and which are never accepted online. Validation is strict because the list decides what a patient
//! may even ask for; any doubt refuses to start.

use std::collections::{BTreeMap, HashMap};
use std::path::Path;

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

use super::{LText, RenewalScope};
use crate::clock::parse_date;
use crate::types::Locale;

const COLUMNS: [&str; 15] = [
    "drug_id",
    "name_zh",
    "name_en",
    "class_id",
    "class_zh",
    "class_en",
    "form",
    "strengths",
    "renewal_scope",
    "controlled_level",
    "reason_zh",
    "reason_en",
    "source_type",
    "source_url",
    "verified_on",
];
/// Taiwan schedules controlled drugs in four levels; 0 means not controlled.
const MAX_CONTROLLED_LEVEL: u8 = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Drug {
    pub drug_id: String,
    pub name: LText,
    pub class_id: String,
    pub class: LText,
    pub form: String,
    pub strengths: Vec<String>,
    pub renewal_scope: RenewalScope,
    pub controlled_level: u8,
    pub reason: LText,
    pub source_type: String,
    pub source_url: Option<String>,
    pub verified_on: Option<String>,
}

/// Contract §3 `DrugRef`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DrugRef {
    pub drug_id: String,
    pub name_zh: String,
    pub name_en: String,
    pub class_id: String,
    pub class_zh: String,
    pub class_en: String,
    pub controlled_level: u8,
}

/// A row of the public `GET /rx/formulary`.
#[derive(Debug, Clone, Serialize)]
pub struct DrugOut<'a> {
    #[serde(flatten)]
    pub drug: DrugRef,
    pub form: &'a str,
    pub strengths: &'a [String],
    pub renewal_scope: RenewalScope,
    pub reason: &'a str,
    pub source_type: &'a str,
    pub source_url: Option<&'a str>,
    pub verified_on: Option<&'a str>,
}

impl Drug {
    pub fn to_ref(&self) -> DrugRef {
        DrugRef {
            drug_id: self.drug_id.clone(),
            name_zh: self.name.zh.clone(),
            name_en: self.name.en.clone(),
            class_id: self.class_id.clone(),
            class_zh: self.class.zh.clone(),
            class_en: self.class.en.clone(),
            controlled_level: self.controlled_level,
        }
    }

    pub fn to_out(&self, locale: Locale) -> DrugOut<'_> {
        DrugOut {
            drug: self.to_ref(),
            form: &self.form,
            strengths: &self.strengths,
            renewal_scope: self.renewal_scope,
            reason: self.reason.get(locale),
            source_type: &self.source_type,
            source_url: self.source_url.as_deref(),
            verified_on: self.verified_on.as_deref(),
        }
    }
}

#[derive(Debug, Clone)]
pub struct Formulary {
    drugs: Vec<Drug>,
    by_id: HashMap<String, usize>,
}

pub(super) fn is_identifier(text: &str) -> bool {
    !text.is_empty()
        && text.len() <= 64
        && text
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

pub(super) fn is_url(text: &str) -> bool {
    (text.starts_with("https://") || text.starts_with("http://"))
        && !text.contains(char::is_whitespace)
}

impl Formulary {
    pub fn load(path: &Path) -> Result<Self> {
        let raw =
            std::fs::read_to_string(path).with_context(|| format!("read {}", path.display()))?;
        Self::parse(&raw).with_context(|| format!("check {}", path.display()))
    }

    pub fn parse(csv_text: &str) -> Result<Self> {
        let mut reader = csv::ReaderBuilder::new()
            .from_reader(csv_text.trim_start_matches('\u{feff}').as_bytes());
        let headers = reader.headers()?.clone();
        let names: Vec<&str> = headers.iter().map(str::trim).collect();
        let mut columns: HashMap<&str, usize> = HashMap::new();
        for name in COLUMNS {
            let index = names
                .iter()
                .position(|h| *h == name)
                .with_context(|| format!("missing column {name}"))?;
            columns.insert(name, index);
        }
        if names.len() != columns.len() {
            bail!("unexpected columns: expected exactly {}", columns.len());
        }

        let mut drugs: Vec<Drug> = Vec::new();
        let mut by_id = HashMap::new();
        let mut classes: BTreeMap<String, LText> = BTreeMap::new();
        for (row_no, row) in reader.records().enumerate() {
            let row = row?;
            let line = row_no + 2;
            let cell = |name: &str| row.get(columns[name]).unwrap_or("").trim().to_string();
            let drug_id = cell("drug_id");
            if !is_identifier(&drug_id) {
                bail!(
                    "line {line}: drug_id must be lower-case letters, digits, _ or - ({drug_id})"
                );
            }
            let required = |name: &str| -> Result<String> {
                let value = cell(name);
                if value.is_empty() {
                    bail!("{drug_id}: {name} is empty");
                }
                Ok(value)
            };
            let class_id = required("class_id")?;
            if !is_identifier(&class_id) {
                bail!("{drug_id}: bad class_id {class_id}");
            }
            let class = LText::new(required("class_zh")?, required("class_en")?);
            match classes.get(&class_id) {
                Some(known) if *known != class => {
                    bail!("{drug_id}: class {class_id} is named differently on another row")
                }
                Some(_) => {}
                None => {
                    classes.insert(class_id.clone(), class.clone());
                }
            }
            let renewal_scope = RenewalScope::parse(&cell("renewal_scope")).with_context(|| {
                format!("{drug_id}: renewal_scope must be in_scope, physician_only or excluded")
            })?;
            let controlled_level: u8 = cell("controlled_level")
                .parse()
                .ok()
                .filter(|n| *n <= MAX_CONTROLLED_LEVEL)
                .with_context(|| format!("{drug_id}: controlled_level must be 0 to 4"))?;
            if controlled_level > 0 && renewal_scope != RenewalScope::Excluded {
                bail!("{drug_id}: a controlled drug must be excluded");
            }
            let reason = LText::new(cell("reason_zh"), cell("reason_en"));
            if reason.zh.is_empty() != reason.en.is_empty() {
                bail!("{drug_id}: reason needs both languages");
            }
            if renewal_scope != RenewalScope::InScope && reason.zh.is_empty() {
                bail!(
                    "{drug_id}: {} needs a reason in both languages",
                    renewal_scope.as_str()
                );
            }
            let source_url = Some(cell("source_url")).filter(|s| !s.is_empty());
            if let Some(url) = &source_url
                && !is_url(url)
            {
                bail!("{drug_id}: bad source_url {url}");
            }
            let source_type = required("source_type")?;
            if source_type == "official" && source_url.is_none() {
                bail!("{drug_id}: an official source needs source_url");
            }
            let verified_on = Some(cell("verified_on")).filter(|s| !s.is_empty());
            if let Some(day) = &verified_on
                && parse_date(day).is_none()
            {
                bail!("{drug_id}: verified_on must be YYYY-MM-DD or empty");
            }
            let drug = Drug {
                name: LText::new(required("name_zh")?, required("name_en")?),
                form: cell("form"),
                strengths: cell("strengths")
                    .split(['|', ';'])
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
                    .collect(),
                drug_id: drug_id.clone(),
                class_id,
                class,
                renewal_scope,
                controlled_level,
                reason,
                source_type,
                source_url,
                verified_on,
            };
            if by_id.insert(drug_id.clone(), drugs.len()).is_some() {
                bail!("{drug_id}: listed twice");
            }
            drugs.push(drug);
        }
        if drugs.is_empty() {
            bail!("the drug list is empty");
        }
        Ok(Self { drugs, by_id })
    }

    pub fn drugs(&self) -> &[Drug] {
        &self.drugs
    }

    pub fn get(&self, drug_id: &str) -> Option<&Drug> {
        self.by_id.get(drug_id).map(|i| &self.drugs[*i])
    }

    pub fn count(&self, scope: RenewalScope) -> usize {
        self.drugs
            .iter()
            .filter(|d| d.renewal_scope == scope)
            .count()
    }

    /// Case-insensitive match on either name or class, optionally limited to one scope.
    pub fn search(&self, q: &str, scope: Option<RenewalScope>) -> Vec<&Drug> {
        let needle = q.trim().to_lowercase();
        self.drugs
            .iter()
            .filter(|d| scope.is_none_or(|s| d.renewal_scope == s))
            .filter(|d| {
                needle.is_empty()
                    || [&d.name.zh, &d.name.en, &d.class.zh, &d.class.en, &d.drug_id]
                        .iter()
                        .any(|text| text.to_lowercase().contains(&needle))
            })
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::super::fixtures::FORMULARY;
    use super::*;

    const HEADER: &str = "drug_id,name_zh,name_en,class_id,class_zh,class_en,form,strengths,renewal_scope,controlled_level,reason_zh,reason_en,source_type,source_url,verified_on";

    fn one(row: &str) -> Result<Formulary> {
        Formulary::parse(&format!("{HEADER}\n{row}\n"))
    }

    #[test]
    fn the_fixture_loads_and_is_searchable() {
        let f = Formulary::parse(FORMULARY).expect("fixture");
        assert!(f.get("amlodipine").is_some());
        assert!(f.get("nope").is_none());
        assert_eq!(f.search("AMLO", None).len(), 1);
        assert_eq!(f.search("", None).len(), f.drugs().len());
        assert!(
            f.search("", Some(RenewalScope::Excluded))
                .iter()
                .all(|d| d.renewal_scope == RenewalScope::Excluded)
        );
        let total: usize = RenewalScope::ALL.iter().map(|s| f.count(*s)).sum();
        assert_eq!(total, f.drugs().len());
    }

    #[test]
    fn a_byte_order_mark_is_fine() {
        assert!(Formulary::parse(&format!("\u{feff}{FORMULARY}")).is_ok());
    }

    #[test]
    fn bad_rows_refuse_to_load() {
        let ok = "x,某藥,X,c,類,Class,tablet,5 mg,in_scope,0,,,project,,";
        one(ok).expect("the good row");
        for row in [
            // bad id, empty name, empty class, unknown scope, bad levels
            "X 1,某藥,X,c,類,Class,tablet,5 mg,in_scope,0,,,project,,",
            "x,,X,c,類,Class,tablet,5 mg,in_scope,0,,,project,,",
            "x,某藥,X,,類,Class,tablet,5 mg,in_scope,0,,,project,,",
            "x,某藥,X,c,類,Class,tablet,5 mg,maybe,0,,,project,,",
            "x,某藥,X,c,類,Class,tablet,5 mg,in_scope,9,,,project,,",
            "x,某藥,X,c,類,Class,tablet,5 mg,in_scope,,,,project,,",
            // a controlled drug must be excluded
            "x,某藥,X,c,類,Class,tablet,5 mg,in_scope,4,管制,controlled,project,,",
            "x,某藥,X,c,類,Class,tablet,5 mg,physician_only,3,管制,controlled,project,,",
            // excluded without a reason, reason in one language only
            "x,某藥,X,c,類,Class,tablet,5 mg,excluded,0,,,project,,",
            "x,某藥,X,c,類,Class,tablet,5 mg,excluded,0,理由,,project,,",
            // sources
            "x,某藥,X,c,類,Class,tablet,5 mg,in_scope,0,,,official,,",
            "x,某藥,X,c,類,Class,tablet,5 mg,in_scope,0,,,project,ftp://x,",
            "x,某藥,X,c,類,Class,tablet,5 mg,in_scope,0,,,project,,2026-13-01",
            "x,某藥,X,c,類,Class,tablet,5 mg,in_scope,0,,,,,",
        ] {
            assert!(one(row).is_err(), "should refuse: {row}");
        }
        assert!(one(&format!("{ok}\n{ok}")).is_err(), "duplicate id");
        let second_name = "y,乙藥,Y,c,別名,Class,tablet,5 mg,in_scope,0,,,project,,";
        assert!(
            one(&format!("{ok}\n{second_name}")).is_err(),
            "one class, two names"
        );
        assert!(Formulary::parse(HEADER).is_err(), "empty list");
        assert!(
            Formulary::parse("drug_id,name_zh\nx,y\n").is_err(),
            "columns"
        );
    }

    #[test]
    fn localised_output_carries_scope_and_reason() {
        let f = Formulary::parse(FORMULARY).expect("fixture");
        let out = serde_json::to_value(f.get("zolpidem").expect("zolpidem").to_out(Locale::En))
            .expect("json");
        assert_eq!(out["renewal_scope"], "excluded");
        assert_eq!(out["controlled_level"], 4);
        assert!(!out["reason"].as_str().expect("reason").is_empty());
    }
}
