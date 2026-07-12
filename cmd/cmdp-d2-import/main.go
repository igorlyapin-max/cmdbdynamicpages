package main

import (
	"flag"
	"fmt"
	"io"
	"os"
)

const (
	defaultMaxInputBytes = 1024 * 1024
	defaultMaxElements   = 5000
	maxInputBytesLimit   = 64 * 1024 * 1024
	maxElementsLimit     = 100000
)

type cliOptions struct {
	maxInputBytes int
	maxElements   int
}

func main() {
	os.Exit(runCLI(os.Args[1:], os.Stdin, os.Stdout))
}

func runCLI(args []string, stdin io.Reader, stdout io.Writer) int {
	opts, err := parseCLIOptions(args)
	if err != nil {
		result := newImportResult(nil)
		result.Source.Errors = append(result.Source.Errors, sourceError{
			Code:    "invalid_argument",
			Message: err.Error(),
		})
		if encodeResult(stdout, result) != nil {
			return 3
		}
		return 2
	}

	input, tooLarge, err := readInput(stdin, opts.maxInputBytes)
	if err != nil {
		result := newImportResult(nil)
		result.Source.Errors = append(result.Source.Errors, sourceError{
			Code:    "input_error",
			Message: fmt.Sprintf("failed to read stdin: %v", err),
		})
		if encodeResult(stdout, result) != nil {
			return 3
		}
		return 2
	}
	if tooLarge {
		result := newImportResult(nil)
		result.Source.Bytes = len(input)
		result.Source.Truncated = true
		result.Source.Errors = append(result.Source.Errors, sourceError{
			Code:    "input_limit_exceeded",
			Message: fmt.Sprintf("D2 input exceeds the configured limit of %d bytes", opts.maxInputBytes),
		})
		if encodeResult(stdout, result) != nil {
			return 3
		}
		return 0
	}

	result := importD2(input, opts.maxElements)
	if encodeResult(stdout, result) != nil {
		return 3
	}
	return 0
}

func parseCLIOptions(args []string) (cliOptions, error) {
	opts := cliOptions{
		maxInputBytes: defaultMaxInputBytes,
		maxElements:   defaultMaxElements,
	}
	flags := flag.NewFlagSet("cmdp-d2-import", flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	flags.IntVar(&opts.maxInputBytes, "max-input-bytes", opts.maxInputBytes, "maximum D2 stdin size in bytes")
	flags.IntVar(&opts.maxElements, "max-elements", opts.maxElements, "maximum normalized element count")
	if err := flags.Parse(args); err != nil {
		return cliOptions{}, err
	}
	if flags.NArg() != 0 {
		return cliOptions{}, fmt.Errorf("unexpected positional arguments: %v", flags.Args())
	}
	if opts.maxInputBytes < 1 || opts.maxInputBytes > maxInputBytesLimit {
		return cliOptions{}, fmt.Errorf("--max-input-bytes must be between 1 and %d", maxInputBytesLimit)
	}
	if opts.maxElements < 1 || opts.maxElements > maxElementsLimit {
		return cliOptions{}, fmt.Errorf("--max-elements must be between 1 and %d", maxElementsLimit)
	}
	return opts, nil
}

func readInput(r io.Reader, maxBytes int) ([]byte, bool, error) {
	input, err := io.ReadAll(io.LimitReader(r, int64(maxBytes)+1))
	if err != nil {
		return nil, false, err
	}
	return input, len(input) > maxBytes, nil
}
