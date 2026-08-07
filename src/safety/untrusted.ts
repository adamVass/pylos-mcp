// UntrustedText wraps mailbox-sourced content so it cannot silently reach tool
// output as a string. It refuses every implicit stringification path (template
// literals, string concatenation, JSON.stringify) by throwing.

// assigned inside the class's static initializer, so it can read the private
// #value field without exposing a public getter
let extract: (t: UntrustedText) => string

export class UntrustedText {
  #value: string

  constructor(value: string) {
    this.#value = value
  }

  static {
    extract = (t: UntrustedText): string => t.#value
  }

  toString(): never {
    throw new Error('UntrustedText must be rendered through safety/render')
  }

  toJSON(): never {
    throw new Error('UntrustedText must be rendered through safety/render')
  }

  [Symbol.toPrimitive](_hint: string): never {
    throw new Error('UntrustedText must be rendered through safety/render')
  }
}

export function makeUntrusted(s: string): UntrustedText {
  return new UntrustedText(s)
}

// ONLY safety/ may import this.
export function readUntrusted(t: UntrustedText): string {
  return extract(t)
}
