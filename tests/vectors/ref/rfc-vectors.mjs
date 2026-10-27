// Published test vectors, copied verbatim from their sources (never invented).
//
// RFC9180_SUITE: the base-mode entry for kem_id 16, kdf_id 1, aead_id 2 from
// the HPKE test vector file that RFC 9180 cites as [TestVectors]:
// https://github.com/cfrg/draft-irtf-cfrg-hpke/blob/5f503c564da00b0687b3de75f1dfbdfc4079ad31/test-vectors.json
// (first encryption, sequence number 0, only; values in hex as in the source).
export const RFC9180_SUITE = {
  "mode": 0,
  "kem_id": 16,
  "kdf_id": 1,
  "aead_id": 2,
  "info": "4f6465206f6e2061204772656369616e2055726e",
  "ikmE": "a90d3417c3da9cb6c6ae19b4b5dd6cc9529a4cc24efb7ae0ace1f31887a8cd6c",
  "pkEm": "04c06b4f6bebc7bb495cb797ab753f911aff80aefb86fd8b6fcc35525f3ab5f03e0b21bd31a86c6048af3cb2d98e0d3bf01da5cc4c39ff5370d331a4f1f7d5a4e0",
  "skEm": "90345e3a1d116c1dd39ae76d95ab858c142223a63e44f8f85318cfa91a84858e",
  "ikmR": "a0ce15d49e28bd47a18a97e147582d814b08cbe00109fed5ec27d1b4e9f6f5e3",
  "pkRm": "04abc7e49a4c6b3566d77d0304addc6ed0e98512ffccf505e6a8e3eb25c685136f853148544876de76c0f2ef99cdc3a05ccf5ded7860c7c021238f9e2073d2356c",
  "skRm": "317f915db7bc629c48fe765587897e01e282d3e8445f79f27f65d031a88082b2",
  "enc": "04c06b4f6bebc7bb495cb797ab753f911aff80aefb86fd8b6fcc35525f3ab5f03e0b21bd31a86c6048af3cb2d98e0d3bf01da5cc4c39ff5370d331a4f1f7d5a4e0",
  "shared_secret": "48893fecd82f7c3456af6a42d8f56325d21e08c10fa81299986aaff54cde7b49",
  "key_schedule_context": "008fc3aeb832490a4b5ab3e42023287db29a1f4bc7c222c0df228727b70a4021127f1ff3fd1aa97af7e5d473e1cb01ba74831133d9659b6c26b03a038a49a84074",
  "secret": "520da82c752ee6e0be7aafbad57a62535d266b6333513d3eb94cb497dceaf94e",
  "key": "ee16802a936d5f544771131900ee6973d0551de9e852ece2ef34bf0d5f9e1d1d",
  "base_nonce": "9bc50980832a7b4b58c40161",
  "exporter_secret": "a8e9a7e62621879fdc89cea7da8e6153458f463e2851baaf009a7461d699cfb6",
  "encryptions": [
    {
      "aad": "436f756e742d30",
      "ct": "58c61a45059d0c5704560e9d88b564a8b63f1364b8d1fcb3c4c6ddc1d291742465e902cd216f8908da49f8f96f",
      "nonce": "9bc50980832a7b4b58c40161",
      "pt": "4265617574792069732074727574682c20747275746820626561757479"
    }
  ]
};

// RFC8291_EXAMPLE: RFC 8291 section 5 example and Appendix A intermediate
// values (base64url as in the RFC, line-wrap whitespace removed).
export const RFC8291_EXAMPLE = {
  plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24',
  as_public: 'BP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  as_private: 'yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw',
  ua_public: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
  ua_private: 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94',
  salt: 'DGv6ra1nlYgDCS1FRnbzlw',
  auth_secret: 'BTBZMqHH6r4Tts7J_aSIgg',
  record_size: 4096,
  ecdh_secret: 'kyrL1jIIOHEzg3sM2ZWRHDRB62YACZhhSlknJ672kSs',
  prk_key: 'Snr3JMxaHVDXHWJn5wdC52WjpCtd2EIEGBykDcZW32k',
  key_info: 'V2ViUHVzaDogaW5mbwAEJXGyvs3942BVGq8e0PTNNmwRzr5VX4m8t7GGpTM5FzFo7OLr4BhZe9MEebhuPI-OztV3ylkYfpJGmQ22ggCLDgT-M_SrDepxkU21WCP3O1SUj0EwbZIHMtu5pZpTKGSCIA5Zent7wmC6HCJ5mFgJkuk5cwAvMBKiiujwa7t45ewP',
  ikm: 'S4lYMb_L0FxCeq0WhDx813KgSYqU26kOyzWUdsXYyrg',
  prk: '09_eUZGrsvxChDCGRCdkLiDXrReGOEVeSCdCcPBSJSc',
  cek_info: 'Q29udGVudC1FbmNvZGluZzogYWVzMTI4Z2NtAA',
  cek: 'oIhVW04MRdy2XN9CiKLxTg',
  nonce_info: 'Q29udGVudC1FbmNvZGluZzogbm9uY2UA',
  nonce: '4h_95klXJ5E_qnoN',
  header: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A8',
  padded_plaintext: 'V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24C',
  ciphertext: '8pfeW0KbunFT06SuDKoJH9Ql87S1QUrdirN6GcG7sFz1y1sqLgVi1VhjVkHsUoEsbI_0LpXMuGvnzQ',
  body: 'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN',
};

// RFC 6979 A.2.5 (P-256, SHA-256): used only by the reference self-test of
// the deterministic signer; not part of the golden file.
export const RFC6979_P256 = {
  x: 'C9AFA9D845BA75166B5C215767B1D6934E50C3DB36E89B127B8A622B120F6721',
  sample: 'EFD48B2AACB6A8FD1140DD9CD45E81D69D2C877B56AAF991C34D0EA84EAF3716F7CB1C942D657C41D436C7A1B6E29F65F3E900DBB9AFF4064DC4AB2F843ACDA8',
  test: 'F1ABB023518351CD71D881567B1EA663ED3EFCF6C5132B354F28D3B0B7D38367019F4113742A2B14BD25926B49C649155F267E60D3814B4C0CC84250E46F0083',
};
