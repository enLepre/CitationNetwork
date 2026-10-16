/* ============================================================
   Citation network dataset
   Seed: "Attention Is All You Need" and its citation neighborhood.
   Metadata (titles/authors/years/venues) is factual; citation
   counts are rounded approximations for the prototype.
   Edge {s, t}  ==  paper `s` cites paper `t`.
   ============================================================ */
window.PAPERS = [
  // ---------- SEED ----------
  { id: "attn", title: "Attention Is All You Need",
    authors: "Vaswani, Shazeer, Parmar, Uszkoreit, Jones, Gomez, Kaiser, Polosukhin",
    short: "Vaswani et al.", year: 2017, venue: "NeurIPS", cites: 124000,
    abstract: "Introduces the Transformer, a sequence transduction architecture based entirely on attention mechanisms, dispensing with recurrence and convolutions while achieving state-of-the-art translation quality at a fraction of the training cost." },

  // ---------- REFERENCES (seed cites these — foundations) ----------
  { id: "seq2seq", title: "Sequence to Sequence Learning with Neural Networks",
    authors: "Sutskever, Vinyals, Le", short: "Sutskever et al.", year: 2014, venue: "NeurIPS", cites: 28000,
    abstract: "Presents a general end-to-end approach to sequence learning using multilayered LSTMs to map an input sequence to a fixed-dimensional vector and then decode the target sequence." },
  { id: "bahdanau", title: "Neural Machine Translation by Jointly Learning to Align and Translate",
    authors: "Bahdanau, Cho, Bengio", short: "Bahdanau et al.", year: 2014, venue: "ICLR", cites: 33000,
    abstract: "Proposes the additive attention mechanism, allowing a translation model to automatically search for parts of a source sentence relevant to predicting each target word." },
  { id: "lstm", title: "Long Short-Term Memory",
    authors: "Hochreiter, Schmidhuber", short: "Hochreiter & Schmidhuber", year: 1997, venue: "Neural Computation", cites: 90000,
    abstract: "Introduces the LSTM recurrent architecture with gated memory cells that overcome the vanishing-gradient problem and learn dependencies over long time lags." },
  { id: "adam", title: "Adam: A Method for Stochastic Optimization",
    authors: "Kingma, Ba", short: "Kingma & Ba", year: 2014, venue: "ICLR", cites: 180000,
    abstract: "Describes Adam, a first-order gradient-based optimizer computing adaptive learning rates from estimates of the first and second moments of the gradients." },
  { id: "layernorm", title: "Layer Normalization",
    authors: "Ba, Kiros, Hinton", short: "Ba et al.", year: 2016, venue: "arXiv", cites: 14000,
    abstract: "Normalizes the summed inputs to neurons within a layer, stabilizing the hidden-state dynamics of recurrent and attention networks without dependence on batch size." },
  { id: "dropout", title: "Dropout: A Simple Way to Prevent Neural Networks from Overfitting",
    authors: "Srivastava, Hinton, Krizhevsky, Sutskever, Salakhutdinov", short: "Srivastava et al.", year: 2014, venue: "JMLR", cites: 52000,
    abstract: "Introduces dropout, randomly omitting units during training to prevent co-adaptation, yielding a powerful and inexpensive form of model regularization." },
  { id: "luong", title: "Effective Approaches to Attention-based Neural Machine Translation",
    authors: "Luong, Pham, Manning", short: "Luong et al.", year: 2015, venue: "EMNLP", cites: 11000,
    abstract: "Examines global and local attention architectures for NMT, introducing multiplicative attention and demonstrating substantial BLEU gains on English–German translation." },
  { id: "convs2s", title: "Convolutional Sequence to Sequence Learning",
    authors: "Gehring, Auli, Grangier, Yarats, Dauphin", short: "Gehring et al.", year: 2017, venue: "ICML", cites: 4200,
    abstract: "Builds a fully convolutional encoder–decoder with gated linear units and attention, enabling parallel computation over sequence elements during training." },
  { id: "gnmt", title: "Google's Neural Machine Translation System",
    authors: "Wu, Schuster, Chen, Le, Norouzi, et al.", short: "Wu et al.", year: 2016, venue: "arXiv", cites: 8300,
    abstract: "Bridges the gap between research and production NMT with a deep LSTM model using residual connections, attention, and word-piece tokenization." },

  // ---------- CITING (these cite the seed — its impact) ----------
  { id: "bert", title: "BERT: Pre-training of Deep Bidirectional Transformers for Language Understanding",
    authors: "Devlin, Chang, Lee, Toutanova", short: "Devlin et al.", year: 2019, venue: "NAACL", cites: 95000,
    abstract: "Pre-trains deep bidirectional Transformer representations by jointly conditioning on left and right context via masked-language modelling, advancing the state of the art across eleven NLP tasks." },
  { id: "gpt", title: "Improving Language Understanding by Generative Pre-Training",
    authors: "Radford, Narasimhan, Salimans, Sutskever", short: "Radford et al.", year: 2018, venue: "OpenAI", cites: 12000,
    abstract: "Demonstrates that generative pre-training of a Transformer language model on unlabeled text followed by discriminative fine-tuning yields large gains across diverse language tasks." },
  { id: "gpt2", title: "Language Models are Unsupervised Multitask Learners",
    authors: "Radford, Wu, Child, Luan, Amodei, Sutskever", short: "Radford et al.", year: 2019, venue: "OpenAI", cites: 16000,
    abstract: "Shows that a high-capacity Transformer language model (GPT-2) trained on a large web corpus performs many tasks zero-shot, without task-specific training." },
  { id: "gpt3", title: "Language Models are Few-Shot Learners",
    authors: "Brown, Mann, Ryder, Subbiah, et al.", short: "Brown et al.", year: 2020, venue: "NeurIPS", cites: 30000,
    abstract: "Scales an autoregressive Transformer to 175 billion parameters (GPT-3) and shows strong few-shot performance via in-context learning without gradient updates." },
  { id: "roberta", title: "RoBERTa: A Robustly Optimized BERT Pretraining Approach",
    authors: "Liu, Ott, Goyal, Du, et al.", short: "Liu et al.", year: 2019, venue: "arXiv", cites: 22000,
    abstract: "Replicates and improves BERT pre-training through longer training, larger batches, more data, and removal of next-sentence prediction, matching or exceeding later methods." },
  { id: "xlnet", title: "XLNet: Generalized Autoregressive Pretraining for Language Understanding",
    authors: "Yang, Dai, Yang, Carbonell, Salakhutdinov, Le", short: "Yang et al.", year: 2019, venue: "NeurIPS", cites: 9500,
    abstract: "Combines autoregressive and autoencoding objectives via permutation language modelling, integrating Transformer-XL to outperform BERT on twenty tasks." },
  { id: "t5", title: "Exploring the Limits of Transfer Learning with a Unified Text-to-Text Transformer",
    authors: "Raffel, Shazeer, Roberts, Lee, et al.", short: "Raffel et al.", year: 2020, venue: "JMLR", cites: 16000,
    abstract: "Casts every NLP problem as text-to-text and conducts a systematic study of transfer learning, releasing the T5 model and the C4 corpus." },
  { id: "vit", title: "An Image is Worth 16x16 Words: Transformers for Image Recognition at Scale",
    authors: "Dosovitskiy, Beyer, Kolesnikov, et al.", short: "Dosovitskiy et al.", year: 2021, venue: "ICLR", cites: 35000,
    abstract: "Applies a pure Transformer directly to sequences of image patches (ViT), attaining excellent image-classification results when pre-trained on large datasets." },
  { id: "albert", title: "ALBERT: A Lite BERT for Self-supervised Learning of Language Representations",
    authors: "Lan, Chen, Goodman, Gimpel, Sharma, Soricut", short: "Lan et al.", year: 2020, venue: "ICLR", cites: 6800,
    abstract: "Reduces BERT's memory footprint and training time through factorized embeddings and cross-layer parameter sharing while improving downstream performance." },
  { id: "electra", title: "ELECTRA: Pre-training Text Encoders as Discriminators Rather Than Generators",
    authors: "Clark, Luong, Le, Manning", short: "Clark et al.", year: 2020, venue: "ICLR", cites: 5200,
    abstract: "Replaces masked-language modelling with replaced-token detection, training the model to distinguish real from generated tokens for far greater compute efficiency." },
  { id: "transformerxl", title: "Transformer-XL: Attentive Language Models Beyond a Fixed-Length Context",
    authors: "Dai, Yang, Yang, Carbonell, Le, Salakhutdinov", short: "Dai et al.", year: 2019, venue: "ACL", cites: 5400,
    abstract: "Introduces segment-level recurrence and relative positional encodings, enabling Transformers to learn dependencies far beyond a fixed context window." },
  { id: "distilbert", title: "DistilBERT, a distilled version of BERT: smaller, faster, cheaper and lighter",
    authors: "Sanh, Debut, Chaumond, Wolf", short: "Sanh et al.", year: 2019, venue: "arXiv", cites: 8900,
    abstract: "Uses knowledge distillation to compress BERT by 40% while retaining 97% of its language-understanding capabilities and running 60% faster." },
  { id: "longformer", title: "Longformer: The Long-Document Transformer",
    authors: "Beltagy, Peters, Cohan", short: "Beltagy et al.", year: 2020, venue: "arXiv", cites: 4600,
    abstract: "Introduces an attention mechanism that scales linearly with sequence length, combining local windowed attention with task-motivated global attention." },
  { id: "reformer", title: "Reformer: The Efficient Transformer",
    authors: "Kitaev, Kaiser, Levskaya", short: "Kitaev et al.", year: 2020, venue: "ICLR", cites: 2900,
    abstract: "Improves Transformer efficiency with locality-sensitive-hashing attention and reversible residual layers, processing very long sequences with limited memory." }
];

window.EDGES = [
  // seed -> references
  { s: "attn", t: "seq2seq" }, { s: "attn", t: "bahdanau" }, { s: "attn", t: "lstm" },
  { s: "attn", t: "adam" },    { s: "attn", t: "layernorm" }, { s: "attn", t: "dropout" },
  { s: "attn", t: "luong" },   { s: "attn", t: "convs2s" },   { s: "attn", t: "gnmt" },

  // citing -> seed
  { s: "bert", t: "attn" }, { s: "gpt", t: "attn" }, { s: "gpt2", t: "attn" },
  { s: "gpt3", t: "attn" }, { s: "roberta", t: "attn" }, { s: "xlnet", t: "attn" },
  { s: "t5", t: "attn" }, { s: "vit", t: "attn" }, { s: "albert", t: "attn" },
  { s: "electra", t: "attn" }, { s: "transformerxl", t: "attn" }, { s: "distilbert", t: "attn" },
  { s: "longformer", t: "attn" }, { s: "reformer", t: "attn" },

  // cross-references among references
  { s: "seq2seq", t: "lstm" }, { s: "bahdanau", t: "seq2seq" }, { s: "luong", t: "bahdanau" },
  { s: "luong", t: "seq2seq" }, { s: "convs2s", t: "bahdanau" }, { s: "gnmt", t: "seq2seq" },
  { s: "gnmt", t: "lstm" }, { s: "convs2s", t: "dropout" }, { s: "gnmt", t: "bahdanau" },

  // citing papers referencing the foundations
  { s: "gpt", t: "seq2seq" }, { s: "bert", t: "seq2seq" }, { s: "gpt2", t: "adam" },
  { s: "t5", t: "dropout" }, { s: "transformerxl", t: "lstm" },

  // cross-references among citing papers
  { s: "gpt2", t: "gpt" }, { s: "gpt3", t: "gpt2" }, { s: "gpt3", t: "gpt" },
  { s: "roberta", t: "bert" }, { s: "albert", t: "bert" }, { s: "electra", t: "bert" },
  { s: "distilbert", t: "bert" }, { s: "xlnet", t: "bert" }, { s: "xlnet", t: "transformerxl" },
  { s: "vit", t: "bert" }, { s: "t5", t: "bert" }, { s: "t5", t: "gpt2" },
  { s: "longformer", t: "bert" }, { s: "longformer", t: "roberta" }, { s: "longformer", t: "transformerxl" },
  { s: "reformer", t: "transformerxl" }, { s: "albert", t: "roberta" }, { s: "electra", t: "roberta" },
  { s: "vit", t: "gpt3" }, { s: "gpt3", t: "t5" }
];

window.SEED_ID = "attn";
