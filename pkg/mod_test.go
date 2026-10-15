package pkg
func TestMod(t *testing.T) {
	if Mod() != 2 { t.Fail() }
}
