//! Correct the pinned FACT generator's pre-realloc string limit, not guest code.
//! Its old checks use destination widths (and retry expansion factors). The
//! reference limits SOURCE bytes instead. That bound also makes the old allocation
//! arithmetic checks redundant: even 3 * source units is below 2^31.
use anyhow::{bail, ensure, Context, Result};
use std::collections::HashMap;
use wasmtime_environ::wasmparser::{self, BlockType, Operator as Op, Parser, Payload, TypeRef};

const MAX: i64 = (1 << 28) - 1;
const OLD: i64 = (1 << 31) - 1;
const PIN: &str = "rev = \"4675ee16b703b33948073a5ff6b961367371e7a1\"";

pub(super) fn correct(wasm: &[u8]) -> Result<Vec<u8>> {
    ensure!(
        include_str!("../../../Cargo.toml").contains(PIN),
        "FACT string-limit correction needs review for new environ pin"
    );
    let mut output = wasm.to_vec();
    let mut transcodes = HashMap::new();
    let mut trap = None;
    let mut function_index = 0;
    for payload in Parser::new(0).parse_all(wasm) {
        match payload? {
            Payload::ImportSection(imports) => {
                for import in imports.into_imports() {
                    let import = import?;
                    if !matches!(import.ty, TypeRef::Func(_)) {
                        continue;
                    }
                    if import.module == "transcode" {
                        let op = import
                            .name
                            .split_once(" (mem")
                            .context("FACT transcode name drift")?
                            .0;
                        let (width, args) = match op {
                            "utf8-to-utf8" | "latin1-to-latin1" | "latin1-to-utf16"
                            | "utf8-to-utf16" | "utf8-to-latin1" => (1, 3),
                            "utf16-to-utf16"
                            | "utf16-to-latin1"
                            | "utf16-to-compact-probably-utf16" => (2, 3),
                            "latin1-to-utf8" | "utf8-to-compact-utf16" => (1, 5),
                            "utf16-to-utf8" | "utf16-to-compact-utf16" => (2, 5),
                            _ => bail!("FACT transcode operation drift: {op}"),
                        };
                        transcodes.insert(function_index, (width, args));
                    }
                    if import.module == "runtime"
                        && import.name
                            == format!("trap{}", wasmtime_environ::Trap::StringOutOfBounds as u8)
                    {
                        trap = Some(function_index);
                    }
                    function_index += 1;
                }
            }
            Payload::CodeSectionEntry(body) if !transcodes.is_empty() => {
                let ops = body
                    .get_operators_reader()?
                    .into_iter_with_offsets()
                    .map(|op| op.map(|(op, offset)| (op, offset as usize)))
                    .collect::<Result<Vec<_>, _>>()?;
                rewrite_body(
                    &ops,
                    &transcodes,
                    trap.context("FACT string trap missing")?,
                    &mut output,
                )?;
            }
            _ => {}
        }
    }
    ensure!(
        output.len() == wasm.len(),
        "FACT correction changed module length"
    );
    wasmparser::Validator::new_with_features(super::features())
        .validate_all(&output)
        .context("invalid FACT adapter after string-limit correction")?;
    Ok(output)
}

// Parse only the straight-line argument expressions FACT emits. In particular,
// calls and control flow cannot be mistaken for a source-length expression.
fn expression_start(ops: &[(Op<'_>, usize)], end: usize) -> Result<usize> {
    ensure!(end > 0, "FACT transcode argument underflow");
    let i = end - 1;
    match ops[i].0 {
        Op::LocalGet { .. } | Op::I32Const { .. } | Op::I64Const { .. } => Ok(i),
        Op::I32WrapI64 | Op::I64ExtendI32U => expression_start(ops, i),
        Op::I32Add | Op::I64Add | Op::I32Sub | Op::I64Sub | Op::I32Shl | Op::I64Shl => {
            expression_start(ops, expression_start(ops, i)?)
        }
        _ => bail!("FACT transcode argument shape drift"),
    }
}

fn rewrite_body(
    ops: &[(Op<'_>, usize)],
    transcodes: &HashMap<u32, (i64, usize)>,
    trap: u32,
    output: &mut [u8],
) -> Result<()> {
    // A path identifies branches, not just nesting depth. A guard in one arm
    // cannot authorize a transcode in its sibling, or after that arm has ended.
    let mut path = Vec::new();
    let mut guards: Vec<(u32, Vec<usize>, i64)> = Vec::new();
    let mut pending: Option<(u32, Vec<usize>, usize)> = None;
    let mut i = 0;
    while i < ops.len() {
        let value = match ops[i].0 {
            Op::I32Const { value } => Some(i64::from(value)),
            Op::I64Const { value } => Some(value),
            _ => None,
        };
        if value.is_some_and(|v| [OLD, OLD / 2, OLD / 3].contains(&v))
            && i > 0
            && matches!(ops[i - 1].0, Op::LocalGet { .. })
            && matches!(ops.get(i + 3).map(|o| &o.0), Some(Op::Call { function_index }) if *function_index == trap)
        {
            let local = match ops[i - 1].0 {
                Op::LocalGet { local_index } => local_index,
                _ => unreachable!(),
            };
            let wide = matches!(ops[i].0, Op::I64Const { .. });
            ensure!(
                matches!(ops.get(i + 1).map(|o| &o.0), Some(Op::I64GtU)) && wide
                    || matches!(ops.get(i + 1).map(|o| &o.0), Some(Op::I32GtU)) && !wide,
                "FACT string comparison drift"
            );
            ensure!(
                matches!(
                    ops.get(i + 2).map(|o| &o.0),
                    Some(Op::If {
                        blockty: BlockType::Empty
                    })
                ) && matches!(ops.get(i + 3).map(|o| &o.0), Some(Op::Call { function_index }) if *function_index == trap)
                    && matches!(ops.get(i + 4).map(|o| &o.0), Some(Op::Unreachable))
                    && matches!(ops.get(i + 5).map(|o| &o.0), Some(Op::End)),
                "FACT string guard shape drift"
            );
            ensure!(pending.is_none(), "FACT unassociated string guard");
            pending = Some((local, path.clone(), i));
            i += 6;
            continue;
        }
        match &ops[i].0 {
            Op::Block { .. } | Op::Loop { .. } | Op::If { .. } | Op::TryTable { .. } => {
                path.push(i)
            }
            Op::Else | Op::End => {
                if let Some((_, scope, _)) = &pending {
                    ensure!(
                        path.len() > scope.len(),
                        "FACT string guard crosses control-flow scope"
                    );
                }
                path.pop();
                if matches!(ops[i].0, Op::Else) {
                    path.push(i);
                }
                guards.retain(|(_, scope, _)| path.starts_with(scope));
            }
            Op::LocalSet { local_index } | Op::LocalTee { local_index } => {
                ensure!(
                    !pending
                        .as_ref()
                        .is_some_and(|(local, _, _)| local == local_index),
                    "FACT guarded source length overwritten"
                );
                guards.retain(|(local, _, _)| local != local_index);
            }
            Op::Br { .. } | Op::BrTable { .. } | Op::Return => {
                ensure!(pending.is_none(), "FACT string guard crosses branch");
            }
            Op::BrIf { relative_depth } if pending.is_some() => {
                let scope = &pending.as_ref().unwrap().1;
                ensure!(
                    path.len() - *relative_depth as usize > scope.len(),
                    "FACT string guard crosses conditional branch"
                );
            }
            Op::Call { function_index } if transcodes.contains_key(function_index) => {
                let (width, nargs) = transcodes[function_index];
                let mut end = i;
                // Skip destination arguments; the second argument is source units.
                for _ in 2..nargs {
                    end = expression_start(ops, end)?;
                }
                let start = expression_start(ops, end)?;
                let (local, retry) = match &ops[start..end] {
                    [(Op::LocalGet { local_index }, _)] => (*local_index, false),
                    [(Op::LocalGet { local_index }, _), (Op::LocalGet { .. }, _), (Op::I32Sub | Op::I64Sub, _)] => {
                        (*local_index, true)
                    }
                    _ => bail!("FACT source length expression drift"),
                };
                if retry {
                    ensure!(
                        guards.iter().any(|(l, scope, w)| *l == local
                            && *w == width
                            && path.starts_with(scope)),
                        "FACT retry missing original source bound"
                    );
                }
                if let Some((guard_local, scope, constant)) = pending.take() {
                    ensure!(
                        scope == path && guard_local == local,
                        "FACT string guard/transcode association drift"
                    );
                    let mut value = MAX / width;
                    // Keep the original signed-LEB width, including legal padding.
                    let bytes = &mut output[ops[constant].1 + 1..ops[constant + 1].1];
                    let len = bytes.len();
                    for (j, byte) in bytes.iter_mut().enumerate() {
                        *byte = (value as u8 & 0x7f) | if j + 1 < len { 0x80 } else { 0 };
                        value >>= 7;
                    }
                    ensure!(value == 0, "FACT string immediate width drift");
                    guards.push((local, scope, width));
                }
                ensure!(
                    guards
                        .iter()
                        .any(|(l, scope, w)| *l == local && *w == width && path.starts_with(scope)),
                    "FACT transcode missing dominating source guard"
                );
            }
            _ => {}
        }
        i += 1;
    }
    ensure!(pending.is_none(), "FACT string guard has no transcode");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn module(body: &str) -> Vec<u8> {
        wat::parse_str(format!(
            r#"(module
            (import "runtime" "trap{}" (func $trap))
            (import "transcode" "utf8-to-utf8 (mem0 => mem1)" (func $copy (param i32 i32 i32)))
            (func (param i32 i32) {body}))"#,
            wasmtime_environ::Trap::StringOutOfBounds as u8
        ))
        .unwrap()
    }

    const GUARD: &str = "local.get 0 i32.const 2147483647 i32.gt_u if call $trap unreachable end";
    const CALL: &str = "i32.const 0 local.get 0 i32.const 0 call $copy";

    #[test]
    fn padded_immediate_and_unrelated_constants() {
        let input = module(&format!(
            "{GUARD} {CALL} local.get 1 i32.const 2147483647 i32.gt_u drop"
        ));
        let output = correct(&input).unwrap();
        assert_eq!(input.len(), output.len());
        let differences = input.iter().zip(&output).filter(|(a, b)| a != b).count();
        assert_eq!(differences, 1); // only the top group in the five-byte LEB
        assert_eq!(
            input.iter().filter(|b| **b == 7).count(),
            output.iter().filter(|b| **b == 7).count() + 1
        );
    }

    #[test]
    fn no_strings_is_byte_identical() {
        let input = wat::parse_str(
            "(module (func (param i32) local.get 0 i32.const 2147483647 i32.gt_u drop))",
        )
        .unwrap();
        assert_eq!(correct(&input).unwrap(), input);
    }

    #[test]
    fn drift_fails_closed() {
        let cases = [
            CALL.to_string(),
            format!("{} {CALL}", GUARD.replace("i32.gt_u", "i32.ge_u")),
            format!("{} {CALL}", GUARD.replace("2147483647", "2147483646")),
            format!("{} {CALL}", GUARD.replace("unreachable", "nop")),
            format!("{GUARD} i32.const 0 local.set 0 {CALL}"),
            format!("{GUARD} i32.const 0 local.tee 0 drop {CALL}"),
            format!("i32.const 1 if {GUARD} else {CALL} end"),
            format!("block {GUARD} end {CALL}"),
            format!("block {GUARD} br 0 {CALL} end"),
            format!("block {GUARD} i32.const 1 br_if 0 {CALL} end"),
            format!("{GUARD} i32.const 0 local.get 1 i32.const 0 call $copy"),
            format!("{GUARD} i32.const 0 local.get 0 local.get 1 i32.sub i32.const 0 call $copy"),
            format!("{GUARD} return"),
        ];
        for body in cases {
            assert!(correct(&module(&body)).is_err(), "accepted drift: {body}");
        }
    }

    #[test]
    fn memory64_guard_uses_same_source_bound() {
        let input = wat::parse_str(format!(
            r#"(module
            (import "runtime" "trap{}" (func $trap))
            (import "transcode" "utf16-to-utf16 (mem0 => mem1)" (func $copy (param i64 i64 i64)))
            (func (param i64)
                local.get 0 i64.const 1073741823 i64.gt_u if call $trap unreachable end
                i64.const 0 local.get 0 i64.const 0 call $copy))"#,
            wasmtime_environ::Trap::StringOutOfBounds as u8
        ))
        .unwrap();
        let output = correct(&input).unwrap();
        assert_eq!(input.len(), output.len());
        assert_ne!(input, output);
    }
}
