//! Parity harness for the Rust port of the Clef joint schema head.
//!
//! Reads the deterministic synthetic case written by
//! `tools/joint_head_reference.py`, runs `joint_head.rs` on it and dumps the
//! logits (plus intermediate stages) as raw little-endian float32 files so the
//! PyTorch reference can be compared against them.
//!
//! Usage:
//!   cargo run --bin joint_head_probe -- \
//!       --head <joint_head.safetensors> \
//!       --input <tools/fixtures/input> \
//!       --output <tools/fixtures/rust>

#[path = "../joint_head.rs"]
mod joint_head;

use anyhow::{anyhow, bail, Context, Result};
use joint_head::{EncodedQuestion, EncodedRecord, JointSchemaHead};
use mlx_rs::Array;
use serde_json::json;
use std::path::{Path, PathBuf};

fn read_f32(path: &Path) -> Result<Vec<f32>> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    if bytes.len() % 4 != 0 {
        bail!("{} has {} bytes, not a multiple of 4", path.display(), bytes.len());
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|chunk| f32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect())
}

fn read_i32(path: &Path) -> Result<Vec<i32>> {
    let bytes = std::fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    if bytes.len() % 4 != 0 {
        bail!("{} has {} bytes, not a multiple of 4", path.display(), bytes.len());
    }
    Ok(bytes
        .chunks_exact(4)
        .map(|chunk| i32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]]))
        .collect())
}

fn write_f32(path: &Path, values: &[f32]) -> Result<()> {
    let mut bytes = Vec::with_capacity(values.len() * 4);
    for value in values {
        bytes.extend_from_slice(&value.to_le_bytes());
    }
    std::fs::write(path, bytes).with_context(|| format!("writing {}", path.display()))
}

fn array_to_vec(array: &Array) -> Result<Vec<f32>> {
    let contiguous = array.contiguous()?;
    contiguous
        .to_vec_cast::<f32>()
        .map_err(|error| anyhow!("failed to read array as f32: {error:?}"))
}

fn parse_span(value: &serde_json::Value) -> Result<(usize, usize)> {
    let pair = value
        .as_array()
        .ok_or_else(|| anyhow!("span is not an array: {value}"))?;
    if pair.len() != 2 {
        bail!("span must have two entries: {value}");
    }
    Ok((
        pair[0].as_u64().context("span start is not an integer")? as usize,
        pair[1].as_u64().context("span end is not an integer")? as usize,
    ))
}

fn parse_records(case: &serde_json::Value) -> Result<Vec<EncodedRecord>> {
    let records = case
        .get("records")
        .and_then(|value| value.as_array())
        .ok_or_else(|| anyhow!("case.json has no `records` array"))?;
    records
        .iter()
        .map(|record| {
            let record_id = record
                .get("record_id")
                .and_then(|value| value.as_str())
                .unwrap_or("record")
                .to_string();
            let questions = record
                .get("questions")
                .and_then(|value| value.as_array())
                .ok_or_else(|| anyhow!("record has no `questions` array"))?
                .iter()
                .map(|question| {
                    let question_id = question
                        .get("question_id")
                        .and_then(|value| value.as_str())
                        .unwrap_or("question")
                        .to_string();
                    let question_type = question
                        .get("question_type")
                        .and_then(|value| value.as_i64())
                        .ok_or_else(|| anyhow!("question has no `question_type`"))?
                        as i32;
                    let question_span = parse_span(
                        question
                            .get("question_span")
                            .ok_or_else(|| anyhow!("question has no `question_span`"))?,
                    )?;
                    let option_spans = question
                        .get("option_spans")
                        .and_then(|value| value.as_array())
                        .ok_or_else(|| anyhow!("question has no `option_spans` array"))?
                        .iter()
                        .map(parse_span)
                        .collect::<Result<Vec<_>>>()?;
                    let option_ids = question
                        .get("option_ids")
                        .and_then(|value| value.as_array())
                        .map(|values| {
                            values
                                .iter()
                                .map(|value| value.as_str().unwrap_or_default().to_string())
                                .collect::<Vec<_>>()
                        })
                        .unwrap_or_default();
                    Ok(EncodedQuestion {
                        question_id,
                        question_type,
                        question_span,
                        option_spans,
                        option_ids,
                    })
                })
                .collect::<Result<Vec<_>>>()?;
            Ok(EncodedRecord {
                record_id,
                questions,
            })
        })
        .collect()
}

fn main() -> Result<()> {
    let mut head_path = PathBuf::from(
        "/Users/mac/.cache/huggingface/hub/models--Cloudflare--clef-flash/snapshots/fb4417d31c1d0f9e7e77f1141b40aaede7491e00/joint_head.safetensors",
    );
    let mut input_dir = PathBuf::from("tools/fixtures/input");
    let mut output_dir = PathBuf::from("tools/fixtures/rust");

    let mut args = std::env::args().skip(1);
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--head" => head_path = PathBuf::from(args.next().context("--head needs a path")?),
            "--input" => input_dir = PathBuf::from(args.next().context("--input needs a path")?),
            "--output" => output_dir = PathBuf::from(args.next().context("--output needs a path")?),
            other => bail!("unknown argument `{other}`"),
        }
    }

    let case_bytes = std::fs::read(input_dir.join("case.json"))
        .with_context(|| format!("reading {}/case.json", input_dir.display()))?;
    let case: serde_json::Value = serde_json::from_slice(&case_bytes).context("parsing case.json")?;
    let batch = case
        .get("batch")
        .and_then(|value| value.as_u64())
        .ok_or_else(|| anyhow!("case.json has no `batch`"))? as usize;
    let seq_len = case
        .get("seq_len")
        .and_then(|value| value.as_u64())
        .ok_or_else(|| anyhow!("case.json has no `seq_len`"))? as usize;
    let hidden_size = case
        .get("hidden_size")
        .and_then(|value| value.as_u64())
        .ok_or_else(|| anyhow!("case.json has no `hidden_size`"))? as usize;
    let vocab_size = case
        .get("vocab_size")
        .and_then(|value| value.as_u64())
        .ok_or_else(|| anyhow!("case.json has no `vocab_size`"))? as usize;

    let hidden = read_f32(&input_dir.join("hidden_states.f32"))?;
    if hidden.len() != batch * seq_len * hidden_size {
        bail!(
            "hidden_states.f32 has {} floats, expected {}",
            hidden.len(),
            batch * seq_len * hidden_size
        );
    }
    let input_ids = read_i32(&input_dir.join("input_ids.i32"))?;
    let attention_mask = read_i32(&input_dir.join("attention_mask.i32"))?;
    let output_embedding = read_f32(&input_dir.join("output_embedding.f32"))?;
    if output_embedding.len() != vocab_size * hidden_size {
        bail!(
            "output_embedding.f32 has {} floats, expected {}",
            output_embedding.len(),
            vocab_size * hidden_size
        );
    }

    let records = parse_records(&case)?;

    let head = JointSchemaHead::load_safetensors(&head_path)?;
    println!(
        "loaded joint head from {} ({} records, batch={batch}, seq_len={seq_len})",
        head_path.display(),
        records.len()
    );

    let hidden_states =
        Array::from_slice(&hidden, &[batch as i32, seq_len as i32, hidden_size as i32]);
    let input_ids_array = Array::from_slice(&input_ids, &[batch as i32, seq_len as i32]);
    let attention_mask_array = Array::from_slice(&attention_mask, &[batch as i32, seq_len as i32]);
    let output_embedding_array =
        Array::from_slice(&output_embedding, &[vocab_size as i32, hidden_size as i32]);

    let (logits, trace) = head.forward_traced(
        &hidden_states,
        &input_ids_array,
        &attention_mask_array,
        &records,
        &output_embedding_array,
    )?;

    // Cross-check the plain entry point against the traced one.
    let plain = head.forward(
        &hidden_states,
        &input_ids_array,
        &attention_mask_array,
        &records,
        &output_embedding_array,
    )?;
    for (record_index, (traced, plain)) in logits.iter().zip(plain.iter()).enumerate() {
        for (question_index, (traced, plain)) in traced.iter().zip(plain.iter()).enumerate() {
            if array_to_vec(traced)? != array_to_vec(plain)? {
                bail!(
                    "forward and forward_traced disagree at record {record_index} question {question_index}"
                );
            }
        }
    }

    std::fs::create_dir_all(&output_dir)
        .with_context(|| format!("creating {}", output_dir.display()))?;

    let mut flat: Vec<f32> = Vec::new();
    for record_logits in &logits {
        for question_logits in record_logits {
            flat.extend(array_to_vec(question_logits)?);
        }
    }
    write_f32(&output_dir.join("logits.f32"), &flat)?;

    let mut stages: Vec<serde_json::Value> = Vec::new();
    if let Some(normalized_hidden) = &trace.normalized_hidden {
        let name = "normalized_hidden";
        let file = format!("stage_{name}.f32");
        write_f32(&output_dir.join(&file), &array_to_vec(normalized_hidden)?)?;
        stages.push(json!({
            "name": name,
            "index": 0,
            "file": file,
            "shape": normalized_hidden.shape(),
        }));
    }
    for (stage, values) in [
        ("memory", &trace.memory),
        ("question_vectors", &trace.question_vectors),
        ("option_queries", &trace.option_queries),
        ("routed_options", &trace.routed_options),
        ("fields", &trace.fields),
    ] {
        for (index, value) in values.iter().enumerate() {
            let file = format!("stage_{stage}_{index}.f32");
            write_f32(&output_dir.join(&file), &array_to_vec(value)?)?;
            stages.push(json!({
                "name": stage,
                "index": index,
                "file": file,
                "shape": value.shape(),
            }));
        }
    }

    let manifest = json!({
        "logits": {"file": "logits.f32", "shape": [flat.len()]},
        "stages": stages,
    });
    std::fs::write(
        output_dir.join("manifest.json"),
        serde_json::to_vec_pretty(&manifest)?,
    )?;
    println!(
        "wrote {} logits and {} stage tensors to {}",
        flat.len(),
        stages.len(),
        output_dir.display()
    );

    Ok(())
}
