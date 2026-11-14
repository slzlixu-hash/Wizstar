'use strict';

/**
 * 极简 JSON Schema 校验器（只覆盖本服务 schema 用到的子集）。
 *
 * 不引入 ajv 的原因：1688 MCP 只需校验扁平的入参结构，
 * 自带 60 行校验器可以避免给离线环境新增依赖，也便于把错误信息统一成 40001。
 */

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function matchesType(type, v) {
  const actual = typeOf(v);
  if (type === 'number') return actual === 'number' || actual === 'integer';
  return actual === type;
}

/**
 * @param {object} schema JSON Schema 片段
 * @param {any} value
 * @param {string} [path]
 * @returns {{ok: true} | {ok: false, errors: Array<{path:string,message:string}>}}
 */
export function validate(schema, value, path = '$') {
  const errors = [];
  check(schema, value, path, errors);
  return errors.length ? { ok: false, errors } : { ok: true };
}

function check(schema, value, path, errors) {
  if (!schema || typeof schema !== 'object') return;

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({ path, message: `取值必须是 ${schema.enum.map((v) => JSON.stringify(v)).join(' / ')} 之一` });
    return;
  }

  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    if (!types.some((t) => matchesType(t, value))) {
      errors.push({ path, message: `类型应为 ${types.join('|')}，实际是 ${typeOf(value)}` });
      return;
    }
  }

  if (typeof value === 'string') {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push({ path, message: `长度不能小于 ${schema.minLength}` });
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      errors.push({ path, message: `长度不能大于 ${schema.maxLength}` });
    }
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) {
      errors.push({ path, message: `格式不匹配 ${schema.pattern}` });
    }
  }

  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) errors.push({ path, message: `不能小于 ${schema.minimum}` });
    if (schema.maximum != null && value > schema.maximum) errors.push({ path, message: `不能大于 ${schema.maximum}` });
  }

  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push({ path, message: `数组至少 ${schema.minItems} 项` });
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errors.push({ path, message: `数组最多 ${schema.maxItems} 项` });
    }
    if (schema.items) value.forEach((item, i) => check(schema.items, item, `${path}[${i}]`, errors));
  }

  if (schema.type === 'object' || schema.properties) {
    const props = schema.properties || {};
    for (const key of schema.required || []) {
      if (value?.[key] == null) errors.push({ path: `${path}.${key}`, message: '必填参数缺失' });
    }
    for (const [key, sub] of Object.entries(props)) {
      if (value?.[key] !== undefined) check(sub, value[key], `${path}.${key}`, errors);
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(value || {})) {
        if (!(key in props)) errors.push({ path: `${path}.${key}`, message: '不支持的参数' });
      }
    }
  }
}
