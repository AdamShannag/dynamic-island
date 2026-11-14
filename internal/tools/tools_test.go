package tools

import "testing"

func TestFormat(t *testing.T) {
	c := format(53.0/255, 132.0/255, 228.0/255)
	if c.Hex != "#3584E4" || c.RGB != "rgb(53, 132, 228)" || c.HSL != "hsl(213, 76%, 55%)" {
		t.Fatalf("got %+v", c)
	}
	if c := format(1, 1, 1); c.HSL != "hsl(0, 0%, 100%)" {
		t.Fatalf("white: %+v", c)
	}
}

func TestQR(t *testing.T) {
	p, err := QR("https://example.com")
	if err != nil || p == "" {
		t.Fatal(err)
	}
}
