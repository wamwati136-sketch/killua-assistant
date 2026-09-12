/**
 * tools/calculator.js
 * Level 1 (SAFE) — pure arithmetic, no side effects.
 *
 * Deliberately does NOT use eval()/new Function() on model-supplied
 * input. Instead this implements a small tokenizer + recursive-descent
 * parser that only understands numbers, + - * / % ^, parentheses,
 * unary minus, and a short allow-list of math functions/constants.
 */

const FUNCTIONS = {
  sqrt: Math.sqrt,
  abs: Math.abs,
  sin: Math.sin,
  cos: Math.cos,
  tan: Math.tan,
  log: Math.log10,   // log base 10 (common calculator convention)
  ln: Math.log,      // natural log
  exp: Math.exp,
  round: Math.round,
  floor: Math.floor,
  ceil: Math.ceil,
};

const CONSTANTS = {
  pi: Math.PI,
  e: Math.E,
};

class ExpressionError extends Error {}

function tokenize(input) {
  const tokens = [];
  let i = 0;
  const src = input.trim();

  while (i < src.length) {
    const ch = src[i];

    if (/\s/.test(ch)) { i++; continue; }

    if (/[0-9.]/.test(ch)) {
      let start = i;
      while (i < src.length && /[0-9.]/.test(src[i])) i++;
      tokens.push({ type: 'num', value: parseFloat(src.slice(start, i)) });
      continue;
    }

    if (/[a-zA-Z_]/.test(ch)) {
      let start = i;
      while (i < src.length && /[a-zA-Z_]/.test(src[i])) i++;
      tokens.push({ type: 'ident', value: src.slice(start, i).toLowerCase() });
      continue;
    }

    if ('+-*/%^(),'.includes(ch)) {
      tokens.push({ type: 'op', value: ch });
      i++;
      continue;
    }

    throw new ExpressionError(`Unexpected character "${ch}" in expression`);
  }

  return tokens;
}

// Recursive-descent parser: expr -> term (('+'|'-') term)*
//                           term -> power (('*'|'/'|'%') power)*
//                           power -> unary ('^' power)?      (right-assoc)
//                           unary -> ('-')? primary
//                           primary -> number | ident '(' expr ')' | ident | '(' expr ')'
function parse(tokens) {
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];

  function parseExpr() {
    let value = parseTerm();
    while (peek() && peek().type === 'op' && (peek().value === '+' || peek().value === '-')) {
      const op = next().value;
      const rhs = parseTerm();
      value = op === '+' ? value + rhs : value - rhs;
    }
    return value;
  }

  function parseTerm() {
    let value = parsePower();
    while (peek() && peek().type === 'op' && ['*', '/', '%'].includes(peek().value)) {
      const op = next().value;
      const rhs = parsePower();
      if (op === '*') value *= rhs;
      else if (op === '/') {
        if (rhs === 0) throw new ExpressionError('Division by zero');
        value /= rhs;
      } else value %= rhs;
    }
    return value;
  }

  function parsePower() {
    const base = parseUnary();
    if (peek() && peek().type === 'op' && peek().value === '^') {
      next();
      const exponent = parsePower(); // right-associative
      return Math.pow(base, exponent);
    }
    return base;
  }

  function parseUnary() {
    if (peek() && peek().type === 'op' && peek().value === '-') {
      next();
      return -parseUnary();
    }
    if (peek() && peek().type === 'op' && peek().value === '+') {
      next();
      return parseUnary();
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const tok = peek();
    if (!tok) throw new ExpressionError('Unexpected end of expression');

    if (tok.type === 'num') {
      next();
      return tok.value;
    }

    if (tok.type === 'op' && tok.value === '(') {
      next();
      const value = parseExpr();
      if (!peek() || peek().value !== ')') throw new ExpressionError('Missing closing parenthesis');
      next();
      return value;
    }

    if (tok.type === 'ident') {
      next();
      const name = tok.value;

      // function call: name(...)
      if (peek() && peek().type === 'op' && peek().value === '(') {
        next();
        const arg = parseExpr();
        if (!peek() || peek().value !== ')') throw new ExpressionError('Missing closing parenthesis');
        next();
        if (!(name in FUNCTIONS)) throw new ExpressionError(`Unknown function "${name}"`);
        return FUNCTIONS[name](arg);
      }

      if (name in CONSTANTS) return CONSTANTS[name];
      throw new ExpressionError(`Unknown identifier "${name}"`);
    }

    throw new ExpressionError(`Unexpected token "${tok.value}"`);
  }

  const result = parseExpr();
  if (pos !== tokens.length) throw new ExpressionError('Unexpected trailing input');
  return result;
}

function safeEvaluate(expression) {
  if (typeof expression !== 'string' || expression.length === 0) {
    throw new ExpressionError('Expression must be a non-empty string');
  }
  if (expression.length > 200) {
    throw new ExpressionError('Expression too long');
  }
  const tokens = tokenize(expression);
  const result = parse(tokens);
  if (typeof result !== 'number' || !isFinite(result)) {
    throw new ExpressionError('Expression did not evaluate to a finite number');
  }
  return result;
}

const definition = {
  type: 'function',
  function: {
    name: 'calculate',
    description:
      'Evaluate a mathematical expression safely (arithmetic, %, ^, parentheses, sqrt/abs/sin/cos/tan/log/ln/exp/round/floor/ceil, pi, e). Use this any time the user asks for a calculation instead of doing arithmetic yourself.',
    parameters: {
      type: 'object',
      properties: {
        expression: {
          type: 'string',
          description: 'The math expression to evaluate, e.g. "sqrt(144) + 12 * (3 - 1)"',
        },
      },
      required: ['expression'],
    },
  },
};

async function execute(args) {
  try {
    const result = safeEvaluate(args.expression);
    return { ok: true, expression: args.expression, result };
  } catch (err) {
    return { ok: false, expression: args.expression, error: err.message };
  }
}

module.exports = {
  level: 1,
  definition,
  execute,
  softConfirm: false,
};
