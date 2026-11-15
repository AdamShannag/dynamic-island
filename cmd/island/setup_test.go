package main

import (
	"reflect"
	"testing"
)

func TestStrvRoundTrip(t *testing.T) {
	cases := map[string][]string{
		"@as []":                  nil,
		"[]":                      nil,
		"['a@b', 'c@d']\n":        {"a@b", "c@d"},
		"['dynamic-island@x.io']": {"dynamic-island@x.io"},
	}
	for in, want := range cases {
		if got := parseStrv(in); !reflect.DeepEqual(got, want) {
			t.Errorf("parseStrv(%q) = %v, want %v", in, got, want)
		}
	}
	list := []string{"a@b", "c@d"}
	if got := parseStrv(formatStrv(list)); !reflect.DeepEqual(got, list) {
		t.Errorf("round trip = %v", got)
	}
}
