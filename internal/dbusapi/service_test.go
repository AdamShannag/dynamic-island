package dbusapi

import (
	"encoding/xml"
	"reflect"
	"sort"
	"testing"
)

func TestIntrospectionMatchesExportedMethods(t *testing.T) {
	var node struct {
		Interfaces []struct {
			Name    string `xml:"name,attr"`
			Methods []struct {
				Name string `xml:"name,attr"`
			} `xml:"method"`
		} `xml:"interface"`
	}
	if err := xml.Unmarshal([]byte(introXML), &node); err != nil {
		t.Fatal(err)
	}
	var declared []string
	for _, in := range node.Interfaces {
		if in.Name != Iface {
			continue
		}
		for _, m := range in.Methods {
			declared = append(declared, m.Name)
		}
	}
	var exported []string
	typ := reflect.TypeOf(&api{})
	for i := 0; i < typ.NumMethod(); i++ {
		exported = append(exported, typ.Method(i).Name)
	}
	sort.Strings(declared)
	sort.Strings(exported)
	if !reflect.DeepEqual(declared, exported) {
		t.Fatalf("introspection and exported methods differ:\ndeclared: %v\nexported: %v", declared, exported)
	}
}
