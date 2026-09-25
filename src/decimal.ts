export type DecimalInput = string | number;

function powerOfTen(exponent: number): bigint {
  return 10n ** BigInt(exponent);
}

export class ExactDecimal {
  private constructor(
    private readonly coefficient: bigint,
    private readonly scale: number,
  ) {}

  static zero(): ExactDecimal {
    return new ExactDecimal(0n, 0);
  }

  static parse(value: DecimalInput, field = "value"): ExactDecimal {
    const text = typeof value === "number" ? value.toString() : value.trim();
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error(`${field} must be a finite decimal.`);
    }

    const match = /^([+-]?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(
      text,
    );
    if (!match) throw new Error(`${field} must be a decimal number.`);

    const sign = match[1] === "-" ? -1n : 1n;
    const integer = match[2];
    const fraction = match[3] ?? "";
    const exponent = Number(match[4] ?? "0");
    if (!Number.isSafeInteger(exponent)) {
      throw new Error(`${field} has an unsupported exponent.`);
    }

    let coefficient = sign * BigInt(`${integer}${fraction}`);
    let scale = fraction.length - exponent;
    if (scale < 0) {
      coefficient *= powerOfTen(-scale);
      scale = 0;
    }

    return ExactDecimal.normalize(coefficient, scale);
  }

  private static normalize(coefficient: bigint, scale: number): ExactDecimal {
    let normalizedCoefficient = coefficient;
    let normalizedScale = scale;
    while (
      normalizedScale > 0 &&
      normalizedCoefficient !== 0n &&
      normalizedCoefficient % 10n === 0n
    ) {
      normalizedCoefficient /= 10n;
      normalizedScale -= 1;
    }
    if (normalizedCoefficient === 0n) normalizedScale = 0;
    return new ExactDecimal(normalizedCoefficient, normalizedScale);
  }

  private align(other: ExactDecimal): [bigint, bigint, number] {
    const scale = Math.max(this.scale, other.scale);
    return [
      this.coefficient * powerOfTen(scale - this.scale),
      other.coefficient * powerOfTen(scale - other.scale),
      scale,
    ];
  }

  add(other: ExactDecimal): ExactDecimal {
    const [left, right, scale] = this.align(other);
    return ExactDecimal.normalize(left + right, scale);
  }

  subtract(other: ExactDecimal): ExactDecimal {
    return this.add(other.negate());
  }

  multiplyInteger(multiplier: number): ExactDecimal {
    if (!Number.isSafeInteger(multiplier)) {
      throw new Error("Decimal multiplier must be a safe integer.");
    }
    return ExactDecimal.normalize(
      this.coefficient * BigInt(multiplier),
      this.scale,
    );
  }

  half(): ExactDecimal {
    if (this.coefficient % 2n === 0n) {
      return ExactDecimal.normalize(this.coefficient / 2n, this.scale);
    }
    return ExactDecimal.normalize(this.coefficient * 5n, this.scale + 1);
  }

  negate(): ExactDecimal {
    return new ExactDecimal(-this.coefficient, this.scale);
  }

  abs(): ExactDecimal {
    return this.coefficient < 0n ? this.negate() : this;
  }

  compare(other: ExactDecimal): number {
    const [left, right] = this.align(other);
    return left < right ? -1 : left > right ? 1 : 0;
  }

  isZero(): boolean {
    return this.coefficient === 0n;
  }

  toString(): string {
    if (this.scale === 0) return this.coefficient.toString();

    const negative = this.coefficient < 0n;
    const digits = (negative ? -this.coefficient : this.coefficient)
      .toString()
      .padStart(this.scale + 1, "0");
    const split = digits.length - this.scale;
    return `${negative ? "-" : ""}${digits.slice(0, split)}.${digits.slice(split)}`;
  }
}
