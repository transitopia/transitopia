//========== About this module ==========

// This is https://github.com/rauschma/asserttt/blob/main/src/asserttt.ts
// By Axel Rauschmayer

// MIT License

// Copyright (c) 2025 Axel Rauschmayer

// Permission is hereby granted, free of charge, to any person obtaining a copy
// of this software and associated documentation files (the "Software"), to deal
// in the Software without restriction, including without limitation the rights
// to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
// copies of the Software, and to permit persons to whom the Software is
// furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all
// copies or substantial portions of the Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
// IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
// FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
// AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
// LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
// OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
// SOFTWARE.

//========== Asserting ==========

/**
 * - Is type `_T` assignable to `true`
 * - Based on code by Blaine Bublitz.
 */
export type Assert<_T extends true> = void;

/**
 * Is the type of `_value` assignable to `T`?
 */
export function assertType<T>(_value: T): void {}

//========== Predicates: equality ==========

/**
 * - Is type `X` equal to type `Y` (with `any` only being equal to itself)?
 * - Name motivated by Node’s assert.equal().
 * - Like `MutuallyAssignable` but `any` is only equal to itself.
 */
export type Equal<X, Y> =
  [IsAny<X>, IsAny<Y>] extends [true, true] ? true
  : [IsAny<X>, IsAny<Y>] extends [false, false] ? MutuallyAssignable<X, Y>
  : false;

/**
 * - The brackets on the left-hand side of `extends` prevent
 *   distributivity.
 */
export type MutuallyAssignable<X, Y> = [X, Y] extends [Y, X] ? true : false;

/**
 * - Name motivated by Node’s assert.deepEqual().
 * - Source: https://github.com/Microsoft/TypeScript/issues/27024#issuecomment-421529650
 */
export type PedanticEqual<X, Y> =
  (<T>() => T extends X ? 1 : 2) extends <T>() => T extends Y ? 1 : 2 ? true
  : false;

//========== Predicates: comparing types ==========

/**
 * - Does type `Sub` extend type `Super`?
 * - Square brackets around `Sub` prevent distributivity (`Super` is also
 *   in brackets so that the test works).
 */
export type Extends<Sub, Super> = [Sub] extends [Super] ? true : false;

/**
 * - Is type `Target` assignable from type `Source`?
 * - Square brackets around `Source` prevent distributivity (`Target` is
 *   also in brackets so that the test works).
 */
export type Assignable<Target, Source> =
  [Source] extends [Target] ? true : false;

/**
 * - Is type `Subset` a subset of type `Superset`?
 * - Square brackets around `Subset` prevent distributivity (`Superset` is
 *   also in brackets so that the test works).
 */
export type Includes<Superset, Subset> =
  [Subset] extends [Superset] ? true : false;

//========== Predicates: boolean operations ==========

/**
 * Boolean NOT for type `B`.
 */
export type Not<B extends boolean> =
  // `Equal` because want to avoid Not<any> being `false` or `true`
  Equal<B, true> extends true ? false
  : Equal<B, false> extends true ? true
  : never;

//========== Predicates: other ==========

/**
 * - Source: https://stackoverflow.com/questions/49927523/disallow-call-with-any/49928360#49928360
 */
export type IsAny<T> = 0 extends 1 & T ? true : false;
